import { makeStorageRuntime } from "./storage/storage-runtime.ts";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { getConnInfo } from "@hono/node-server/conninfo";
import { Context, Effect, Layer } from "effect";

import { createApp, type AppDependencies } from "./app.ts";
import { startArtifactCleanupSupervisor } from "./artifacts/artifact-cleanup-supervisor.ts";
import { makeArtifactControlService } from "./artifacts/artifact-control-service.ts";
import { makeAuthService } from "./auth/auth-service.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "./auth/magic-link-secret.ts";
import { makeBillingService } from "./billing/billing-service.ts";
import type { StripeGatewayDefinition } from "./billing/stripe-gateway.ts";
import { buildCapabilities, buildPublicCapabilities } from "./capabilities.ts";
import type { AppConfig } from "./config.ts";
import { migrateDatabase, openDatabase, type Database } from "./database/database.ts";
import { startEmailOutboxSupervisor } from "./email/email-outbox-supervisor.ts";
import type { EmailSender } from "./email/email-outbox-worker.ts";
import {
  type ApplicationServerBinding,
  startApplicationServer,
} from "./http/application-server.ts";
import { makeRequestIpHasher } from "./http/request-ip.ts";
import { makeExecutionPlanService } from "./execution-plans/execution-plan-service.ts";
import { makeMediaJobCleanup, makeMediaJobProcessor } from "./jobs/media-job-adapter.ts";
import { makeJobService } from "./jobs/job-service.ts";
import { JobCleanup, JobProcessor, startJobWorker } from "./jobs/job-worker.ts";
import {
  startLifecycleSupervisor,
  type LifecycleSupervisor,
} from "./services/lifecycle-supervisor.ts";
import { recoverPreparingJobs } from "./jobs/job-admission-service.ts";
import type { MediaCapabilities } from "./media/inspection/media-capabilities.ts";
import { MediaInspector } from "./media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "./media/process/media-process-runner.ts";
import { checkReadiness } from "./services/readiness.ts";
import { densioSkillBundle } from "./skill-bundle.ts";
import { makePreparedSourceService } from "./sources/prepared-source-service.ts";
import { makeSourceStoragePaths } from "./storage/source-workspace.ts";
import { makeOrganizationService } from "./organizations/organization-service.ts";
import { makeOrganizationDeletionService } from "./organizations/organization-deletion-service.ts";
import { makeOrganizationInvitationService } from "./organizations/organization-invitation-service.ts";
import { makeOrganizationInvitationLinks } from "./organizations/organization-invitation-link.ts";
import { makeOrganizationInvitationLinkService } from "./organizations/organization-invitation-link-service.ts";

export interface ApplicationProviders {
  readonly emailSender: EmailSender;
  readonly stripeGateway: StripeGatewayDefinition;
}

export interface ApplicationOptions {
  readonly server?: ApplicationServerBinding;
}

export const startApplication = (
  config: AppConfig,
  providers: ApplicationProviders,
  options: ApplicationOptions = {},
) =>
  Effect.gen(function* () {
    yield* Effect.all(
      [
        Effect.promise(() => mkdir(dirname(config.databasePath), { recursive: true })),
        Effect.promise(() => mkdir(config.mediaRoot, { recursive: true })),
      ],
      { concurrency: "unbounded", discard: true },
    );
    const database = yield* Effect.acquireRelease(
      Effect.sync(() => openDatabase(config.databasePath)),
      (opened) => Effect.sync(() => opened.close()),
    );
    yield* Effect.sync(() => migrateDatabase(database));
    const applicationScope = yield* Effect.scope;
    const runnerContext = yield* Layer.buildWithScope(
      MediaProcessRunner.layer({ concurrency: config.maxConcurrentMediaProcesses }),
      applicationScope,
    );
    const runner = Context.get(runnerContext, MediaProcessRunner);
    return yield* startRuntime(database, config, providers, options, runner);
  });

const startRuntime = Effect.fn("Application.start")(function* (
  database: Database,
  config: AppConfig,
  providers: ApplicationProviders,
  options: ApplicationOptions,
  runner: MediaProcessRunner["Service"],
) {
  const applicationScope = yield* Effect.scope;
  const inspectorContext = yield* Layer.buildWithScope(
    MediaInspector.layer({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      silenceThresholdDb: config.audioSilenceThresholdDb,
    }).pipe(Layer.provide(Layer.succeed(MediaProcessRunner, runner))),
    applicationScope,
  );
  const inspector = Context.get(inspectorContext, MediaInspector);
  const mediaCapabilities = yield* inspector.checkCapabilities();
  const services = makeRuntimeServices(database, config, providers, inspector, mediaCapabilities);
  const maintenance = yield* startMaintenance(database, config, services);
  const worker = yield* startJobWorker(database, config.jobWorker).pipe(
    Effect.provideService(
      JobProcessor,
      makeMediaJobProcessor(database, services.adapterConfig, runner),
    ),
    Effect.provideService(JobCleanup, makeMediaJobCleanup(database, services.adapterConfig)),
  );
  const email = yield* startEmailOutboxSupervisor(
    database,
    providers.emailSender,
    makeMagicLinkOpener(config.authOutboxEncryptionKey),
    config.email,
    makeOrganizationInvitationLinks(config.authOutboxEncryptionKey, config.websiteBaseUrl),
  );
  const artifacts = yield* startArtifactCleanupSupervisor(database, {
    intervalMs: config.artifactCleanupIntervalMs,
    mediaRoot: config.mediaRoot,
  });
  yield* Effect.addFinalizer(() =>
    Effect.all(
      [
        ...maintenance.map((supervisor) => supervisor.stop()),
        worker.stop(),
        email.stop(),
        artifacts.stop(),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid),
  );
  const app = createApp(
    applicationDependencies(
      database,
      config,
      mediaCapabilities,
      services.authService,
      services.billingService,
      services.jobService,
      services.artifactControlService,
      services.executionPlanService,
      services.sourceService,
      services.deletionService,
      services.storage,
      maintenance,
    ),
  );
  yield* startApplicationServer(config.host, config.port, app.fetch, options.server);
  return { url: config.publicBaseUrl };
});

const makeRuntimeServices = (
  database: Database,
  config: AppConfig,
  providers: ApplicationProviders,
  inspector: MediaInspector["Service"],
  mediaCapabilities: MediaCapabilities,
) => {
  const authService = makeAuthService(
    database,
    makeMagicLinkSealer(config.authOutboxEncryptionKey),
  );
  const billingService = makeBillingService(database, providers.stripeGateway);
  const jobService = makeJobService(database, {
    mediaRoot: config.mediaRoot,
    now: Date.now,
    publicBaseUrl: config.publicBaseUrl,
  });
  const sourceService = makePreparedSourceService(database, {
    now: Date.now,
    inspector,
    mediaRoot: config.mediaRoot,
    publicBaseUrl: config.publicBaseUrl,
    sourceTtlMs: config.sourceTtlMs,
    uploadTtlMs: config.uploadTtlMs,
  });
  const storage = makeStorageRuntime(database, config, sourceService);
  const executionPlanService = makeExecutionPlanService(database, {
    ...storage.videoConfig,
    now: Date.now,
    priceIds: config.billing.priceIds,
    maxComparisonSeconds: config.maxComparisonSeconds,
    createId: randomUUID,
    createJobId: randomUUID,
    maxExtractedImages: config.maxExtractedImages,
    mediaRoot: config.mediaRoot,
    planTtlMs: config.planTtlMs,
    publicBaseUrl: config.publicBaseUrl,
    resolveTrimRange: (sourceId, range, videoStreamIndex) =>
      makeSourceStoragePaths(config.mediaRoot, sourceId).pipe(
        Effect.flatMap((paths) =>
          inspector.resolveTrimRange(paths.inputFile, range, videoStreamIndex),
        ),
      ),
    resolveFrameTimestamp: (sourceId, frameIndex, videoStreamIndex) =>
      makeSourceStoragePaths(config.mediaRoot, sourceId).pipe(
        Effect.flatMap((paths) =>
          inspector.resolveFrameTimestamp(paths.inputFile, frameIndex, videoStreamIndex),
        ),
      ),
    toolchain: {
      ffmpegVersion: mediaCapabilities.ffmpegVersion,
      ffprobeVersion: mediaCapabilities.ffprobeVersion,
    },
  });
  const artifactControlService = makeArtifactControlService(database, {
    accessGrantTtlMs: config.artifactAccessGrantTtlMs,
    mediaRoot: config.mediaRoot,
    publicBaseUrl: config.publicBaseUrl,
  });
  return {
    storage,
    deletionService: makeOrganizationDeletionService(database, providers.stripeGateway, {
      mediaRoot: config.mediaRoot,
      publicBaseUrl: config.publicBaseUrl,
      now: Date.now,
    }),
    adapterConfig: {
      artifactAccessGrantTtlMs: config.artifactAccessGrantTtlMs,
      artifactTtlMs: config.artifactTtlMs,
      audioSilenceThresholdDb: config.audioSilenceThresholdDb,
      ffmpegPath: config.ffmpegPath,
      ffmpegVersion: mediaCapabilities.ffmpegVersion,
      ffprobePath: config.ffprobePath,
      ffprobeVersion: mediaCapabilities.ffprobeVersion,
      maxExtractedImages: config.maxExtractedImages,
      hlsMaxScratchBytes: config.hlsMaxScratchBytes,
      mediaRoot: config.mediaRoot,
      publicBaseUrl: config.publicBaseUrl,
    },
    artifactControlService,
    authService,
    billingService,
    executionPlanService,
    jobService,
    sourceService,
  };
};

const applicationDependencies = (
  database: Database,
  config: AppConfig,
  mediaCapabilities: MediaCapabilities,
  authService: ReturnType<typeof makeAuthService>,
  billingService: ReturnType<typeof makeBillingService>,
  jobService: ReturnType<typeof makeJobService>,
  artifactControlService: ReturnType<typeof makeArtifactControlService>,
  executionPlanService: ReturnType<typeof makeExecutionPlanService>,
  sourceService: ReturnType<typeof makePreparedSourceService>,
  deletionService: ReturnType<typeof makeOrganizationDeletionService>,
  storage: ReturnType<typeof makeStorageRuntime>,
  supervisors: readonly LifecycleSupervisor[],
): AppDependencies => {
  const common = { createCorrelationId: randomUUID, now: Date.now };
  const hashRequestIp = makeRequestIpHasher(config.authIpHashSecret, config.trustProxy);
  return {
    storage: storageRouteDependencies(database, common, authService, storage),
    organizationDeletion: {
      ...common,
      authService,
      organizationService: makeOrganizationService(database),
      deletionService,
    },
    organizations: organizationRouteDependencies(database, config, common, authService),
    artifacts: { ...common, database },
    artifactControl: {
      ...common,
      organizationService: makeOrganizationService(database),
      artifactService: artifactControlService,
      authService,
    },
    auth: {
      ...common,
      authConfig: config.auth,
      authService,
      pollAfterSeconds: 2,
      requestIpHash: (request, context) =>
        hashRequestIp(request, getConnInfo(context).remote.address),
    },
    billing: {
      ...common,
      authService,
      organizationService: makeOrganizationService(database),
      billingConfig: config.billing,
      billingService,
    },
    capabilities: {
      ...common,
      organizationService: makeOrganizationService(database),
      publicCapabilities: buildPublicCapabilities(config, mediaCapabilities),
      authService,
      billingService,
      capabilitiesForPlan: (plan) => buildCapabilities(config, mediaCapabilities, plan),
      priceIds: config.billing.priceIds,
    },
    mediaJobs: {
      ...common,
      organizationService: makeOrganizationService(database),
      authService,
      jobService,
    },
    executionPlans: {
      ...common,
      organizationService: makeOrganizationService(database),
      authService,
      billingService,
      executionPlanService,
      priceIds: config.billing.priceIds,
    },
    readiness: () =>
      checkReadiness(
        database,
        config.mediaRoot,
        {
          ffmpegVersion: mediaCapabilities.ffmpegVersion,
          ffprobeVersion: mediaCapabilities.ffprobeVersion,
        },
        supervisors,
      ),
    skill: { bundle: densioSkillBundle, createCorrelationId: common.createCorrelationId },
    sources: {
      sourceUploads: storage.sourceUploads,
      ...common,
      organizationService: makeOrganizationService(database),
      authService,
      billingService,
      maxUploadBytes: config.maxUploadBytes,
      priceIds: config.billing.priceIds,
      sourceService,
    },
  };
};

const storageRouteDependencies = (
  database: Database,
  common: { createCorrelationId: () => string; now: () => number },
  authService: ReturnType<typeof makeAuthService>,
  storage: ReturnType<typeof makeStorageRuntime>,
) => ({
  ...common,
  authService,
  organizationService: makeOrganizationService(database),
  videoService: storage.videoService,
  connectionService: storage.connectionService,
  download: storage.download,
  downloadPackage: storage.downloadPackage,
  sourceUploads: storage.sourceUploads,
});

const startMaintenance = (
  database: Database,
  config: AppConfig,
  services: ReturnType<typeof makeRuntimeServices>,
) =>
  Effect.gen(function* () {
    const storagePolicy = yield* startLifecycleSupervisor(
      services.storage.maintainPolicy,
      60_000,
      "storage-policy",
    );
    const storage = yield* Effect.all({
      connections: startLifecycleSupervisor(
        services.storage.maintainConnections,
        1_000,
        "storage-connections",
      ),
      sources: startLifecycleSupervisor(
        services.storage.maintainSourceUploads,
        1_000,
        "source-ingestion",
      ),
      transfers: startLifecycleSupervisor(
        services.storage.maintainTransfers,
        1_000,
        "storage-transfers",
      ),
    });
    const preparing = yield* startLifecycleSupervisor(
      ({ now }) => recoverPreparingJobs(database, config.mediaRoot, now),
      config.artifactCleanupIntervalMs,
      "job-admission-recovery",
    );
    const sources = yield* startLifecycleSupervisor(
      services.sourceService.maintain,
      config.artifactCleanupIntervalMs,
      "source-preparation",
    );
    const organizationCleanup = yield* startLifecycleSupervisor(
      services.deletionService.maintain,
      config.artifactCleanupIntervalMs,
      "organization-cleanup",
    );
    return [...Object.values(storage), storagePolicy, preparing, sources, organizationCleanup];
  });

const organizationRouteDependencies = (
  database: Database,
  config: AppConfig,
  common: { createCorrelationId: () => string; now: () => number },
  authService: ReturnType<typeof makeAuthService>,
) => ({
  ...common,
  authService,
  organizationService: makeOrganizationService(database),
  invitationService: makeOrganizationInvitationService(database),
  invitationLinkService: makeOrganizationInvitationLinkService(
    database,
    makeOrganizationInvitationLinks(config.authOutboxEncryptionKey, config.websiteBaseUrl),
  ),
  websiteBaseUrl: config.websiteBaseUrl,
  maxInvitationsPerHour: config.organizationMaxInvitationsPerHour,
  maxCreatesPerDay: config.organizationMaxCreatesPerDay,
  publicBaseUrl: config.publicBaseUrl,
});
