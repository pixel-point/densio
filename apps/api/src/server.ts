import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { getConnInfo } from "@hono/node-server/conninfo";
import { serve, type ServerType } from "@hono/node-server";
import { Effect } from "effect";
import Stripe from "stripe";

import { startArtifactCleanupSupervisor } from "./artifacts/artifact-cleanup-supervisor.ts";
import { makeAuthService } from "./auth/auth-service.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "./auth/magic-link-secret.ts";
import { makeBillingService } from "./billing/billing-service.ts";
import { makeStripeGateway } from "./billing/stripe-gateway.ts";
import { buildCapabilities } from "./capabilities.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { migrateDatabase, openDatabase, type Database } from "./database/database.ts";
import { startEmailOutboxSupervisor } from "./email/email-outbox-supervisor.ts";
import { makeConfiguredResendEmailSender } from "./email/resend-email-sender.ts";
import { makeRequestIpHasher } from "./http/request-ip.ts";
import { makeJobService } from "./jobs/job-service.ts";
import { startJobWorker, JobCleanup, JobProcessor } from "./jobs/job-worker.ts";
import { makeMediaJobCleanup, makeMediaJobProcessor } from "./jobs/media-job-adapter.ts";
import { startUploadLifecycleSupervisor } from "./jobs/upload-lifecycle-supervisor.ts";
import { MediaInspector } from "./media/inspection/media-inspector.ts";
import type { MediaCapabilities } from "./media/inspection/media-capabilities.ts";
import { MediaProcessRunner } from "./media/process/media-process-runner.ts";
import { checkReadiness } from "./services/readiness.ts";
import { densioSkillBundle } from "./skill-bundle.ts";
import { validateProductionConfig } from "./runtime-config.ts";
import { createApp, type AppDependencies } from "./app.ts";

const config = loadConfig(process.env);

const main = Effect.scoped(
  Effect.gen(function* () {
    validateProductionConfig(config);
    mkdirSync(dirname(config.databasePath), { recursive: true });
    yield* Effect.promise(() => mkdir(config.mediaRoot, { recursive: true }));
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => openDatabase(config.databasePath)),
      (opened) => Effect.sync(() => opened.close()),
    );
    yield* Effect.sync(() => migrateDatabase(database));
    yield* runServer(database, config).pipe(
      Effect.provide(MediaProcessRunner.layer({ concurrency: config.maxConcurrentMediaProcesses })),
    );
  }),
);

const runServer = Effect.fn("Application.runServer")(function* (
  database: Database,
  appConfig: AppConfig,
) {
  const runner = yield* MediaProcessRunner;
  const mediaCapabilities = yield* MediaInspector.use((inspector) =>
    inspector.checkCapabilities(),
  ).pipe(
    Effect.provide(
      MediaInspector.layer({
        ffmpegPath: appConfig.ffmpegPath,
        ffprobePath: appConfig.ffprobePath,
        silenceThresholdDb: appConfig.audioSilenceThresholdDb,
      }),
    ),
  );
  const authService = makeAuthService(
    database,
    makeMagicLinkSealer(appConfig.authOutboxEncryptionKey),
  );
  const billingService = makeBillingService(
    database,
    makeStripeGateway(new Stripe(appConfig.stripeSecretKey)),
  );
  const jobService = makeJobService(database, {
    maxComparisonSeconds: appConfig.maxComparisonSeconds,
    maxUploadBytes: appConfig.maxUploadBytes,
    mediaRoot: appConfig.mediaRoot,
    publicBaseUrl: appConfig.publicBaseUrl,
    uploadTtlMs: appConfig.uploadTtlMs,
  });
  const adapterConfig = {
    artifactTtlMs: appConfig.artifactTtlMs,
    audioSilenceThresholdDb: appConfig.audioSilenceThresholdDb,
    ffmpegPath: appConfig.ffmpegPath,
    ffprobePath: appConfig.ffprobePath,
    maxExtractedImages: appConfig.maxExtractedImages,
    mediaRoot: appConfig.mediaRoot,
    publicBaseUrl: appConfig.publicBaseUrl,
  };
  const uploads = yield* startUploadLifecycleSupervisor(
    jobService.recoverUploads,
    appConfig.artifactCleanupIntervalMs,
  );
  const worker = yield* startJobWorker(database, appConfig.jobWorker).pipe(
    Effect.provideService(JobProcessor, makeMediaJobProcessor(database, adapterConfig, runner)),
    Effect.provideService(JobCleanup, makeMediaJobCleanup(database, adapterConfig)),
  );
  const email = yield* startEmailOutboxSupervisor(
    database,
    makeConfiguredResendEmailSender(appConfig.resendApiKey),
    makeMagicLinkOpener(appConfig.authOutboxEncryptionKey),
    appConfig.email,
  );
  const artifacts = yield* startArtifactCleanupSupervisor(database, {
    intervalMs: appConfig.artifactCleanupIntervalMs,
    mediaRoot: appConfig.mediaRoot,
  });
  yield* Effect.addFinalizer(() =>
    Effect.all([worker.stop(), email.stop(), artifacts.stop(), uploads.stop()], {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid),
  );

  const app = createApp(
    applicationDependencies(
      database,
      appConfig,
      mediaCapabilities,
      authService,
      billingService,
      jobService,
    ),
  );
  const server = yield* Effect.sync(() =>
    serve(
      { fetch: app.fetch, hostname: appConfig.host, port: appConfig.port },
      ({ address, port }) => process.stdout.write(`Listening on http://${address}:${port}\n`),
    ),
  );
  yield* Effect.addFinalizer(() => closeServer(server));
  yield* waitForShutdown;
});

const applicationDependencies = (
  database: Database,
  appConfig: AppConfig,
  mediaCapabilities: MediaCapabilities,
  authService: ReturnType<typeof makeAuthService>,
  billingService: ReturnType<typeof makeBillingService>,
  jobService: ReturnType<typeof makeJobService>,
): AppDependencies => {
  const common = { createCorrelationId: randomUUID, now: Date.now };
  const hashRequestIp = makeRequestIpHasher(appConfig.authIpHashSecret, appConfig.trustProxy);
  return {
    artifacts: { ...common, database },
    auth: {
      ...common,
      authConfig: appConfig.auth,
      authService,
      billingService,
      pollAfterSeconds: 2,
      priceIds: appConfig.billing.priceIds,
      requestIpHash: (request, context) =>
        hashRequestIp(request, getConnInfo(context).remote.address),
    },
    billing: {
      ...common,
      authService,
      billingConfig: appConfig.billing,
      billingService,
      billingSessionTtlMs: appConfig.billingSessionTtlMs,
    },
    capabilities: {
      ...common,
      authService,
      billingService,
      capabilitiesForPlan: (plan) => buildCapabilities(appConfig, mediaCapabilities, plan),
      priceIds: appConfig.billing.priceIds,
    },
    mediaJobs: {
      ...common,
      authService,
      billingService,
      jobService,
      priceIds: appConfig.billing.priceIds,
    },
    readiness: () =>
      checkReadiness(database, appConfig.mediaRoot, {
        ffmpegVersion: mediaCapabilities.ffmpegVersion,
        ffprobeVersion: mediaCapabilities.ffprobeVersion,
      }),
    skill: { bundle: densioSkillBundle, createCorrelationId: common.createCorrelationId },
  };
};

const closeServer = (server: ServerType) =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
  });

const waitForShutdown = Effect.callback<void>((resume) => {
  const shutdown = () => resume(Effect.void);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return Effect.sync(() => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });
});

Effect.runPromise(main).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Application startup failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
