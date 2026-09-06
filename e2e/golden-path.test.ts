import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import Stripe from "stripe";
import { afterEach, expect, it } from "vitest";

import { startApplication } from "../apps/api/src/application.ts";
import type { StripeGatewayDefinition } from "../apps/api/src/billing/stripe-gateway.ts";
import { makeStripeGateway } from "../apps/api/src/billing/stripe-gateway.ts";
import { loadConfig } from "../apps/api/src/config.ts";
import type { EmailSender } from "../apps/api/src/email/email-outbox-worker.ts";
import { bindApplicationServer } from "../apps/api/src/http/application-server.ts";
import {
  decodeArtifactAuthorization,
  decodeArtifactDeletion,
  decodeArtifactDescriptor,
  decodeArtifactMaterialization,
  decodeBillingSession,
  decodeBillingStatus,
  decodeExecutionPlanCreated,
  decodeJobAccepted,
  decodeJobEvent,
  decodeJobStatus,
  decodePreparedSource,
  decodePreparedSourceDeletion,
  decodePreparedSourceList,
} from "./support/contracts.ts";
import { probeVideo, runCli, startCli, writeVideoFixture } from "./support/driver.ts";
import { loadFirstUseInstructions, verifyFirstCompression } from "./support/onboarding-journey.ts";
import { verifyDirectHls } from "./support/hls-journey.ts";
import {
  createTeamOrganization,
  verifyDefaultClosure,
  joinOrganization,
  verifyOrganizationIsolation,
  verifyOffboarding,
} from "./support/organization-journey.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("runs the complete agent control plane for a real AV1 video", async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-e2e-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  const sourcePath = await writeVideoFixture(directory);
  const email = captureEmail();
  const stripe = stripeHarness();

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* bindApplicationServer("127.0.0.1", 0);
        const apiUrl = `http://127.0.0.1:${server.port}`;
        const config = e2eConfig(directory, apiUrl, server.port);
        yield* startApplication(
          config,
          { emailSender: email.sender, stripeGateway: stripe.gateway },
          { server },
        );
        yield* Effect.promise(async () => {
          await verifyOnboarding(apiUrl, credentialsPath, email, sourcePath, directory);
          const organization = await createTeamOrganization(apiUrl, credentialsPath);
          await upgradeToBasic(apiUrl, credentialsPath, stripe);
          const team = await joinTeammate(
            apiUrl,
            credentialsPath,
            directory,
            email,
            organization.organizationId,
          );
          expect(
            decodeBillingStatus(
              JSON.parse((await runCli(apiUrl, credentialsPath, ["billing", "status"])).stdout),
            ).data,
          ).toMatchObject({ plan: "basic", organizationId: organization.organizationId });

          const source = await inspectSource(apiUrl, credentialsPath, sourcePath);
          await verifyDirectHls(apiUrl, credentialsPath, source.sourceId, directory);
          await verifyOrganizationIsolation(apiUrl, team, source.sourceId);
          await reuseSource(apiUrl, team.memberCredentials, source.sourceId);
          const plan = await createCompressionPlan(apiUrl, team.memberCredentials, source.sourceId);
          const jobId = await executePlan(
            apiUrl,
            team.memberCredentials,
            plan.planId,
            plan.quote.credits,
          );
          const completed = await watchJob(apiUrl, credentialsPath, jobId);
          const artifact = completed.artifacts.find(
            ({ codec, kind }) => codec === "av1" && kind === "video",
          );
          if (artifact === undefined) throw new Error("Compression returned no AV1 artifact.");
          await verifyOffboarding(apiUrl, credentialsPath, team, plan.planId, artifact.id);
          const outputPath = await authorizeAndMaterialize(
            apiUrl,
            credentialsPath,
            directory,
            jobId,
            artifact.id,
            artifact.filename,
          );
          expect(await probeVideo(outputPath)).toMatchObject({
            codec: "av1",
            durationSeconds: 0.5,
            frameRate: "4/1",
            height: 64,
            width: 64,
          });
          await deleteRemoteResources(apiUrl, credentialsPath, artifact.id, source.sourceId);
          const afterDelete = decodeJobStatus(
            JSON.parse((await runCli(apiUrl, credentialsPath, ["jobs", "get", jobId])).stdout),
          ).data;
          expect(afterDelete.state).toBe("succeeded");
          if (afterDelete.state !== "succeeded")
            throw new Error("Deleting bytes changed execution history.");
          expect(afterDelete.receipt).toEqual(completed.receipt);
          await verifyDefaultClosure(apiUrl, credentialsPath, organization);
          expect(afterDelete.artifacts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: artifact.id, availability: "deleted" }),
            ]),
          );
        });
      }),
    ),
  );
});

const verifyOnboarding = async (
  apiUrl: string,
  credentialsPath: string,
  email: ReturnType<typeof captureEmail>,
  sourcePath: string,
  directory: string,
) => {
  const instructions = await loadFirstUseInstructions(apiUrl, credentialsPath);
  await authenticate(
    apiUrl,
    credentialsPath,
    email.nextEmail("e2e@densio.test"),
    "e2e@densio.test",
    instructions.command("auth login", { EMAIL: "e2e@densio.test" }),
  );
  await verifyFirstCompression(apiUrl, credentialsPath, sourcePath, directory, instructions);
};

const authenticate = async (
  apiUrl: string,
  credentialsPath: string,
  nextEmail: Promise<CapturedEmail>,
  emailAddress = "e2e@densio.test",
  command: ReadonlyArray<string> = ["auth", "login", emailAddress],
) => {
  const login = startCli(apiUrl, credentialsPath, command, 20_000);
  const message = await withTimeout(
    Promise.race([
      nextEmail,
      login.result.then((result) =>
        Promise.reject(new Error(`CLI login exited before email delivery: ${result.stderr}`)),
      ),
    ]),
    10_000,
    "Email delivery timed out.",
  );
  expect(message.to).toBe(emailAddress);
  expect(message.html).toContain("Access your account");
  expect(message.html).toContain("Continue");
  const verificationUrl = message.text.split("\n").find((line) => line.startsWith("http"));
  if (verificationUrl === undefined) throw new Error("Email contained no verification URL.");
  expect(new URL(verificationUrl).pathname).toBe("/auth/confirm");
  const confirmation = await fetch(new URL("/v1/auth/confirm", apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: new URL(verificationUrl).searchParams.get("token") }),
  });
  expect(confirmation.status).toBe(200);
  const result = await withTimeout(login.result, 10_000, "CLI login confirmation timed out.");
  expect(result.code, result.stderr).toBe(0);
};

const joinTeammate = async (
  apiUrl: string,
  ownerCredentials: string,
  directory: string,
  email: ReturnType<typeof captureEmail>,
  organizationId: string,
) => {
  const memberCredentials = join(directory, "member-credentials.json");
  const outsiderCredentials = join(directory, "outsider-credentials.json");
  await authenticate(
    apiUrl,
    memberCredentials,
    email.nextEmail("member@densio.test"),
    "member@densio.test",
  );
  await authenticate(
    apiUrl,
    outsiderCredentials,
    email.nextEmail("outsider@densio.test"),
    "outsider@densio.test",
  );
  const member = await joinOrganization(
    apiUrl,
    ownerCredentials,
    memberCredentials,
    organizationId,
    email.nextEmail("member@densio.test"),
  );
  return { ...member, outsiderCredentials };
};

const upgradeToBasic = async (
  apiUrl: string,
  credentialsPath: string,
  stripe: ReturnType<typeof stripeHarness>,
) => {
  const checkout = await runCli(apiUrl, credentialsPath, [
    "billing",
    "subscribe",
    "basic",
    "--idempotency-key",
    "e2e-checkout",
  ]);
  expect(decodeBillingSession(JSON.parse(checkout.stdout)).data.url).toBe(
    "https://checkout.stripe.test/e2e",
  );
  const request = stripe.checkoutRequest();
  expect(request.line_items).toEqual([{ price: "price_basic_e2e", quantity: 1 }]);
  const organizationId = request.metadata?.organizationId;
  if (typeof organizationId !== "string")
    throw new Error("Checkout request contained no organization ID.");

  await submitStripeEvent(
    apiUrl,
    "checkout.session.completed",
    checkoutCompletedEvent(organizationId),
    "evt_e2e_checkout",
  );
  await submitStripeEvent(
    apiUrl,
    "customer.subscription.updated",
    subscriptionUpdatedEvent(),
    "evt_e2e_subscription",
  );
};

const inspectSource = async (apiUrl: string, credentialsPath: string, sourcePath: string) => {
  const inspected = await runCli(apiUrl, credentialsPath, [
    "inspect",
    sourcePath,
    "--idempotency-key",
    "e2e-source-av1",
  ]);
  const source = decodePreparedSource(JSON.parse(inspected.stdout)).data;
  expect(source.state).toBe("ready");
  if (source.state !== "ready") throw new Error(`Source inspection ended in ${source.state}.`);
  expect(source.inspection).toMatchObject({
    displayDimensions: { height: 64, width: 64 },
    durationSeconds: 0.5,
    frameRate: { denominator: 1, framesPerSecond: 4, numerator: 4 },
  });
  expect(source.verifiedBytes).toBeGreaterThan(0);
  expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
  return source;
};

const reuseSource = async (apiUrl: string, credentialsPath: string, sourceId: string) => {
  const listed = decodePreparedSourceList(
    JSON.parse(
      (await runCli(apiUrl, credentialsPath, ["sources", "list", "--state", "ready"])).stdout,
    ),
  ).data;
  expect(listed.sources).toEqual([expect.objectContaining({ sourceId, state: "ready" })]);
  const comparison = await executeSourceWorkflow(
    apiUrl,
    credentialsPath,
    sourceId,
    "compare-quality",
    ["--matrix", "vp9:36", "--matrix", "h265:28", "--samples", "1", "--metric", "ssim,psnr"],
  );
  expect(comparison.result.kind).toBe("compare-quality");
  if (comparison.result.kind !== "compare-quality")
    throw new Error("Expected a matrix comparison.");
  expect(comparison.result.samples).toHaveLength(1);
  expect(comparison.result.variants).toHaveLength(2);
  expect(comparison.result.decision).toMatchObject({
    confidence: "low",
    confidenceBasis: { sampleCount: 1, independentSampleCount: 1 },
  });
  expect(comparison.receipt.intent.sourceId).toBe(sourceId);
  const extraction = await executeSourceWorkflow(
    apiUrl,
    credentialsPath,
    sourceId,
    "extract-images",
    ["--interval", "1"],
  );
  expect(extraction.result.kind).toBe("extract-images");
  expect(extraction.receipt.intent.sourceId).toBe(sourceId);
  for (const artifact of [...comparison.artifacts, ...extraction.artifacts]) {
    const descriptor = decodeArtifactDescriptor(
      JSON.parse((await runCli(apiUrl, credentialsPath, ["artifacts", "get", artifact.id])).stdout),
    ).data;
    expect(descriptor).toMatchObject({ id: artifact.id, availability: "available" });
    await runCli(apiUrl, credentialsPath, ["artifacts", "delete", artifact.id]);
  }
};

const executeSourceWorkflow = async (
  apiUrl: string,
  credentialsPath: string,
  sourceId: string,
  workflow: string,
  flags: Array<string>,
) => {
  const created = decodeExecutionPlanCreated(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "plans",
          "create",
          sourceId,
          workflow,
          ...flags,
          "--idempotency-key",
          `e2e-plan-${workflow}`,
        ])
      ).stdout,
    ),
  ).data;
  if (created.plan.state !== "ready") throw new Error(`Unexpected ${workflow} decision.`);
  const completed = decodeJobStatus(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "plans",
          "execute",
          created.plan.planId,
          "--idempotency-key",
          `e2e-execute-${workflow}`,
          "--max-credits",
          String(created.plan.quote.credits),
          "--timeout",
          "60",
        ])
      ).stdout,
    ),
  ).data;
  if (completed.state !== "succeeded") throw new Error(`${workflow} ended in ${completed.state}.`);
  return completed;
};

const createCompressionPlan = async (apiUrl: string, credentialsPath: string, sourceId: string) => {
  const created = await runCli(apiUrl, credentialsPath, [
    "plans",
    "create",
    sourceId,
    "compress",
    "--codec",
    "av1",
    "--av1-crf",
    "35",
    "--audio",
    "remove",
    "--frame-rate",
    "preserve",
    "--idempotency-key",
    "e2e-plan-av1",
  ]);
  const response = decodeExecutionPlanCreated(JSON.parse(created.stdout)).data;
  expect(response.replayed).toBe(false);
  expect(response.plan.state).toBe("ready");
  if (response.plan.state !== "ready") throw new Error("AV1 plan requires an unexpected decision.");
  expect(response.plan).toMatchObject({
    expectedArtifacts: [{ codec: "av1", kind: "video", mediaType: "video/webm" }],
    availability: "available",
    quote: { kind: "exact" },
    resolvedOptions: { codecs: ["av1"], crf: { av1: 35 } },
    source: { sourceId },
    workflow: "compress",
  });
  expect(response.plan.quote.creditUnits).toBe(Math.round(response.plan.quote.credits * 100));
  expect(response.plan.intentDigest).toMatch(/^[a-f0-9]{64}$/);
  return response.plan;
};

const executePlan = async (
  apiUrl: string,
  credentialsPath: string,
  planId: string,
  exactCredits: number,
) => {
  const argumentsInput = [
    "plans",
    "execute",
    planId,
    "--idempotency-key",
    "e2e-execute-av1",
    "--client-reference",
    "e2e/golden-av1",
    "--max-credits",
    String(exactCredits),
    "--no-wait",
  ];
  const executed = decodeJobAccepted(
    JSON.parse((await runCli(apiUrl, credentialsPath, argumentsInput)).stdout),
  ).data;
  const replayed = decodeJobAccepted(
    JSON.parse((await runCli(apiUrl, credentialsPath, argumentsInput)).stdout),
  ).data;
  expect(replayed.jobId).toBe(executed.jobId);
  const recovered = decodeJobStatus(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "jobs",
          "lookup",
          "--client-reference",
          "e2e/golden-av1",
        ])
      ).stdout,
    ),
  ).data;
  expect(recovered.id).toBe(executed.jobId);
  return executed.jobId;
};

const watchJob = async (apiUrl: string, credentialsPath: string, jobId: string) => {
  const watched = await runCli(apiUrl, credentialsPath, [
    "jobs",
    "watch",
    jobId,
    "--timeout",
    "60",
  ]);
  const rawEvents = watched.stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  rawEvents
    .filter((event) => !isOrganizationSelection(event))
    .forEach((event) => expect(event).toMatchObject({ jobId, type: "job-event" }));
  const events = rawEvents
    .filter((event) => !isOrganizationSelection(event))
    .map((event) => decodeJobEvent(event));
  const sequences = events.map(({ sequence }) => sequence);
  expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(events.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining(["created", "artifact-published", "terminal"]),
  );
  expect(events.at(-1)).toMatchObject({ state: "succeeded" });
  expect(watched.stdout.trim().split("\n")).toHaveLength(1);
  const status = decodeJobStatus(JSON.parse(watched.stdout)).data;
  if (status.state !== "succeeded") throw new Error(`Job ${jobId} ended in ${status.state}.`);
  expect(status).toMatchObject({
    clientReference: "e2e/golden-av1",
    id: jobId,
    progress: { percent: 100, phase: "complete" },
    receipt: {
      billing: { actualCreditUnits: expect.any(Number) },
      intent: { executionPlanId: expect.any(String), sourceId: expect.any(String) },
    },
    state: "succeeded",
  });
  return status;
};

const authorizeAndMaterialize = async (
  apiUrl: string,
  credentialsPath: string,
  directory: string,
  jobId: string,
  artifactId: string,
  filename: string,
) => {
  const authorized = decodeArtifactAuthorization(
    JSON.parse(
      (await runCli(apiUrl, credentialsPath, ["artifacts", "authorize", artifactId])).stdout,
    ),
  ).data;
  expect(authorized).toMatchObject({
    artifact: { availability: "available", id: artifactId },
    download: { method: "GET" },
  });
  const outputDirectory = join(await realpath(directory), "materialized");
  const receipt = decodeArtifactMaterialization(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "artifacts",
          "materialize",
          jobId,
          "--output-dir",
          outputDirectory,
        ])
      ).stdout,
    ),
  ).data;
  expect(receipt).toMatchObject({
    job: { artifacts: [{ id: artifactId }], id: jobId, state: "succeeded" },
    jobId,
    outputDirectory,
  });
  const file = receipt.files.find(({ artifactId: id }) => id === artifactId);
  if (file === undefined) throw new Error("Materialization omitted the AV1 artifact.");
  expect(file).toMatchObject({ filename, verified: true });
  if (receipt.htmlPath === undefined) throw new Error("Compression materialization omitted HTML.");
  const html = await readFile(receipt.htmlPath, "utf8");
  expect(html).toContain(`src="./${filename}"`);
  expect(html).not.toMatch(/token=|\/v1\/artifacts\//);
  return file.path;
};

const deleteRemoteResources = async (
  apiUrl: string,
  credentialsPath: string,
  artifactId: string,
  sourceId: string,
) => {
  const artifact = decodeArtifactDeletion(
    JSON.parse((await runCli(apiUrl, credentialsPath, ["artifacts", "delete", artifactId])).stdout),
  ).data;
  expect(artifact).toMatchObject({ artifactId, deleted: true });
  const source = decodePreparedSourceDeletion(
    JSON.parse((await runCli(apiUrl, credentialsPath, ["sources", "delete", sourceId])).stdout),
  ).data;
  expect(source).toMatchObject({ sourceId, state: "deleted" });
};

interface CapturedEmail {
  readonly html: string;
  readonly text: string;
  readonly to: string;
}

const captureEmail = () => {
  const mailboxes = new Map<string, ReturnType<typeof Promise.withResolvers<CapturedEmail>>>();
  const mailbox = (email: string) => {
    const existing = mailboxes.get(email);
    if (existing !== undefined) return existing;
    const created = Promise.withResolvers<CapturedEmail>();
    mailboxes.set(email, created);
    return created;
  };
  const sender: EmailSender = {
    send: Effect.fn("E2EEmailSender.send")((message) =>
      Effect.sync(() => {
        mailbox(message.to).resolve({ html: message.html, text: message.text, to: message.to });
        mailboxes.delete(message.to);
      }),
    ),
  };
  return { nextEmail: (email: string) => mailbox(email).promise, sender };
};

const stripeHarness = () => {
  const stripe = new Stripe("sk_test_e2e");
  const webhookParser = makeStripeGateway(stripe);
  let checkoutRequest: Stripe.Checkout.SessionCreateParams | undefined;
  const gateway: StripeGatewayDefinition = {
    retrieveCustomer: () => Effect.die("Unexpected customer read"),
    createCustomer: () => Effect.succeed("cus_e2e"),
    findCustomer: () => Effect.succeed(null),
    updateCustomer: () => Effect.die("Unexpected contact"),
    findCheckoutSession: () => Effect.succeed(null),
    retrieveCheckoutSession: () =>
      Effect.sync(() => {
        if (checkoutRequest === undefined) throw new Error("Checkout not created.");
        return {
          id: "cs_e2e",
          url: null,
          status: "complete" as const,
          customerId: "cus_e2e",
          subscriptionId: "sub_e2e",
          expiresAt: Date.now() + 1_800_000,
          organizationId: checkoutRequest.client_reference_id ?? "",
          attemptId: String(checkoutRequest.metadata?.attemptId),
        };
      }),
    listCustomerSubscriptions: () =>
      gateway.retrieveSubscription("sub_e2e").pipe(Effect.map((subscription) => [subscription])),
    createCheckoutSession: Effect.fn("E2EStripe.createCheckout")((request) =>
      Effect.sync(() => {
        checkoutRequest = request;
        return {
          id: "cs_e2e",
          url: "https://checkout.stripe.test/e2e",
          status: "open" as const,
          customerId: "cus_e2e",
          subscriptionId: null,
          expiresAt: Date.now() + 1_800_000,
          organizationId: request.client_reference_id ?? "",
          attemptId: String(request.metadata?.attemptId),
        };
      }),
    ),
    createPortalSession: Effect.fn("E2EStripe.unusedPortal")(() => Effect.die("Unexpected portal")),
    parseWebhook: webhookParser.parseWebhook,
    retrieveSubscription: Effect.fn("E2EStripe.retrieveSubscription")((subscriptionId) =>
      Effect.succeed({
        cancelAtPeriodEnd: false,
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1_000,
        customerId: "cus_e2e",
        priceId: "price_basic_e2e",
        status: "active" as const,
        subscriptionId,
        organizationId: String(checkoutRequest?.subscription_data?.metadata?.organizationId ?? ""),
      }),
    ),
  };
  return {
    checkoutRequest: () => {
      if (checkoutRequest === undefined) throw new Error("Checkout was not requested.");
      return checkoutRequest;
    },
    gateway,
  };
};

const submitStripeEvent = async (
  apiUrl: string,
  type: "checkout.session.completed" | "customer.subscription.updated",
  event: object,
  eventId: string,
) => {
  const payload = JSON.stringify({
    api_version: null,
    created: Math.floor(Date.now() / 1_000),
    data: { object: event },
    id: eventId,
    livemode: false,
    object: "event",
    pending_webhooks: 1,
    request: null,
    type,
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_e2e",
  });
  const response = await fetch(`${apiUrl}/v1/billing/webhook`, {
    body: payload,
    headers: { "content-type": "application/json", "stripe-signature": signature },
    method: "POST",
  });
  expect(response.status, await response.text()).toBe(200);
};

const checkoutCompletedEvent = (organizationId: string) => ({
  client_reference_id: organizationId,
  customer: "cus_e2e",
  metadata: { organizationId },
  object: "checkout.session",
});

const subscriptionUpdatedEvent = () => ({ id: "sub_e2e", object: "subscription" });

const withTimeout = <Value>(promise: Promise<Value>, milliseconds: number, message: string) => {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), milliseconds).unref();
  });
  return Promise.race([promise, timeout]);
};

const e2eConfig = (directory: string, apiUrl: string, port: number) =>
  loadConfig({
    ARTIFACT_CLEANUP_INTERVAL_SECONDS: "1",
    AUTH_IP_HASH_SECRET: "e2e-ip-hash-secret-that-is-long-enough",
    AUTH_OUTBOX_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
    DATABASE_PATH: join(directory, "database.sqlite"),
    EMAIL_FROM: "Densio <login@densio.test>",
    EMAIL_POLL_INTERVAL_MS: "100",
    FFMPEG_PATH: "ffmpeg",
    FFPROBE_PATH: "ffprobe",
    HOST: "127.0.0.1",
    JOB_POLL_INTERVAL_MS: "10",
    MEDIA_ROOT: join(directory, "media"),
    PORT: String(port),
    PUBLIC_BASE_URL: apiUrl,
    WEBSITE_BASE_URL: "http://localhost:3001",
    RESEND_API_KEY: "re_e2e",
    STRIPE_BASIC_PRICE_ID: "price_basic_e2e",
    STRIPE_PRO_PRICE_ID: "price_pro_e2e",
    STRIPE_SCALE_PRICE_ID: "price_scale_e2e",
    STRIPE_SECRET_KEY: "sk_test_e2e",
    STRIPE_WEBHOOK_SECRET: "whsec_e2e",
  });

const isOrganizationSelection = (event: unknown) =>
  typeof event === "object" &&
  event !== null &&
  "type" in event &&
  event.type === "organization-selected";
