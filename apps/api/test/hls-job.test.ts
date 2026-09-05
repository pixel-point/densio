import { MemoryObjectStore } from "./storage-provider-fixture.ts";
import { makeVideoService } from "../src/videos/video-service.ts";
import { makeStorageWorker } from "../src/storage/transfers/storage-worker.ts";
import { readVideo } from "../src/videos/video-catalog.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";
import { storageUsage } from "../src/videos/storage-policy.ts";
import { streamGrantedHls } from "../src/videos/hls-download.ts";
import { createVideoDownloadRoutes } from "../src/routes/video-downloads.ts";
import { resolveStoragePlan } from "../src/videos/storage-plan.ts";
import { removeArtifactBytes } from "../src/database/artifact-repository.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { JobResultSchema } from "@densio/shared";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";
import { claimNextJob } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { artifacts, jobs } from "../src/database/schema.ts";
import { storageConnections } from "../src/database/video-storage-schema.ts";
import { makeMediaJobCleanup, makeMediaJobProcessor } from "../src/jobs/media-job-adapter.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { createJobTestContext, cleanupJobFixtures, queueCanonicalJob } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("recovers a partially uploaded HLS package without re-encoding or publishing a partial master", async () => {
  const { context, config } = await createHlsJobFixture();
  const fixture = await hlsStorageFixture(context, config);
  const receipt = context.database.db.select().from(jobs).get()?.resultJson;
  fixture.stores.public.failNextRead = true;
  await Effect.runPromise(fixture.worker.maintain());
  expect(
    readVideo(context.database, fixture.actor.organizationId, fixture.saved.video.videoId),
  ).not.toHaveProperty("hls.playbackUrl");
  expect(fixture.stores.public.calls.some((call) => call.endsWith("master.m3u8"))).toBe(false);
  fixture.advance(61000);
  await Effect.runPromise(makeStorageWorker(context.database, fixture.workerConfig).maintain());
  expect(
    readVideo(context.database, fixture.actor.organizationId, fixture.saved.video.videoId).state,
  ).toBe("ready");
  expect(fixture.stores.public.objects.size).toBe(4);
  expect(
    fixture.stores.public.calls.filter(
      (call) => call.startsWith("put:") && call.endsWith("init_v0.mp4"),
    ),
  ).toHaveLength(1);
  expect(context.database.db.select().from(jobs).all()).toHaveLength(1);
  expect(context.database.db.select().from(jobs).get()?.resultJson).toBe(receipt);
}, 30000);

it("exports every HLS member from durable storage after the temporary archive has expired", async () => {
  const { context, config } = await createHlsJobFixture();
  const fixture = await hlsStorageFixture(context, config);
  await Effect.runPromise(fixture.worker.maintain());
  fixture.advance(61000);
  await Effect.runPromise(fixture.worker.maintain());
  const artifact = context.database.db.select().from(artifacts).get()!;
  await Effect.runPromise(removeArtifactBytes(context.database, artifact, config.mediaRoot));
  context.database.db
    .insert(storageConnections)
    .values({
      id: "hls-customer",
      organizationId: fixture.actor.organizationId,
      name: "Website",
      configJson: JSON.stringify({
        provider: "s3",
        visibility: "public",
        publicBaseUrl: "https://customer.example.test",
        location: {
          endpoint: "https://s3.example.test",
          region: "auto",
          bucket: "hls-customer",
          prefix: "site",
          pathStyle: true,
        },
      }),
      credentialsCiphertext: "fixture",
      state: "active",
      validatedAt: fixture.storageConfig.now(),
      createdAt: fixture.storageConfig.now(),
      updatedAt: fixture.storageConfig.now(),
      idempotencyKey: "hls-customer",
      requestDigest: "a".repeat(64),
    })
    .run();
  const customer = new MemoryObjectStore("hls-customer", new Map());
  const exported = await Effect.runPromise(
    fixture.service.export({
      ...fixture.actor,
      videoId: fixture.saved.video.videoId,
      connectionId: "hls-customer",
      idempotencyKey: "hls-export",
    }),
  );
  const worker = makeStorageWorker(context.database, {
    ...fixture.workerConfig,
    resolveTarget: async (id, role) => ({
      id,
      role,
      store: id.startsWith("connection:") ? customer : fixture.stores[role],
      publicOrigin: "https://customer.example.test",
    }),
  });
  await Effect.runPromise(worker.maintain());
  expect(
    readVideo(context.database, fixture.actor.organizationId, exported.video.videoId),
  ).toMatchObject({
    state: "ready",
    hls: { playbackUrl: expect.stringContaining("https://customer.example.test/") },
  });
  expect(customer.objects.size).toBe(4);
  expect(customer.calls.filter((call) => call.startsWith("put:")).at(-1)).toMatch(/master\.m3u8$/);
  expect(
    storageUsage(context.database, fixture.storageConfig, fixture.actor.organizationId).usedBytes,
  ).toBe(fixture.saved.video.hls?.packageBytes);
}, 30000);

it("publishes one HLS archive and an authoritative package inventory that survives workspace cleanup", async () => {
  const { context, config, paths, result } = await createHlsJobFixture();
  expect(result.kind).toBe("hls");
  const published = context.database.db.select().from(artifacts).all();
  expect(published).toMatchObject([{ kind: "hls-archive", filename: "hls.zip" }]);
  const inventory = context.database.sqlite.prepare("select * from hls_packages").get();
  expect(inventory).toMatchObject({ artifact_id: published[0]?.id, job_id: "job-1" });
  const job = context.database.db.select().from(jobs).get();
  if (!job || !published[0] || typeof inventory?.directory !== "string")
    throw new Error("Expected published package");
  await Effect.runPromise(makeMediaJobCleanup(context.database, config).cleanup(job));
  await expect(access(paths.inputFile)).rejects.toMatchObject({ code: "ENOENT" });
  await access(published[0].path);
  const master = await readFile(join(inventory.directory, "master.m3u8"), "utf8");
  expect(master).toContain("hvc1.");
  expect(master).not.toContain("TYPE=AUDIO");
}, 30000);

it("delivers all package members before advertising playback and withdraws the complete package", async () => {
  const { context, config, result } = await createHlsJobFixture();
  const { actor, stores, storageConfig, service, saved, workerConfig, worker, advance } =
    await hlsStorageFixture(context, config);
  expect(
    resolveStoragePlan(context.database, storageConfig, actor.organizationId, "demo.mp4", {
      sourceId: "source-1",
      workflow: "hls",
      storage: { destination: { kind: "managed" } },
    }),
  ).toMatchObject({ files: [{ kind: "hls-package", filename: "master.m3u8", codec: "h265" }] });
  await Effect.runPromise(worker.maintain());
  const video = readVideo(context.database, actor.organizationId, saved.video.videoId);
  expect(video).toMatchObject({
    state: "ready",
    variants: [],
    hls: {
      packageId: result.kind === "hls" ? result.packageId : "",
      playbackUrl: expect.stringMatching(/\/master\.m3u8$/),
    },
  });
  const writes = stores.public.calls.filter(
    (call) => call.startsWith("put:") || call.startsWith("complete:"),
  );
  expect(writes.at(-1)).toMatch(/master\.m3u8$/);
  expect(stores.public.objects.size).toBe(4);
  expect(storageUsage(context.database, storageConfig, actor.organizationId).usedBytes).toBe(
    result.kind === "hls" ? result.packageBytes : -1,
  );
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: video.videoId,
      visibility: "private",
      idempotencyKey: "hls-private",
    }),
  );
  await Effect.runPromise(worker.maintain());
  advance(61000);
  await Effect.runPromise(worker.maintain());
  const artifact = context.database.db.select().from(artifacts).get()!;
  await Effect.runPromise(removeArtifactBytes(context.database, artifact, config.mediaRoot));
  await expect(access(artifact.path)).rejects.toMatchObject({ code: "ENOENT" });
  const grant = await Effect.runPromise(
    service.authorizePackage({ ...actor, videoId: video.videoId }),
  );
  expect(grant.package.members).toHaveLength(4);
  const token = new URL(grant.download.baseUrl).pathname.split("/").filter(Boolean).at(-1)!;
  const downloads = createVideoDownloadRoutes({
    createCorrelationId: () => "hls-test",
    download: () => Effect.succeed(new Response()),
    downloadPackage: (input) => streamGrantedHls(context.database, workerConfig, input),
  });
  for (const member of grant.package.members) {
    const response = await downloads.request(
      `/v1/hls-downloads/${video.videoId}/${token}/${encodeURIComponent(member.path)}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(
      createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex"),
    ).toBe(member.sha256);
  }
  await Effect.runPromise(
    service.remove({ ...actor, videoId: video.videoId, idempotencyKey: "hls-delete" }),
  );
  await expect(
    Effect.runPromise(
      streamGrantedHls(context.database, workerConfig, {
        videoId: video.videoId,
        token,
        filename: "master.m3u8",
      }),
    ),
  ).rejects.toMatchObject({ code: "VIDEO_NOT_FOUND" });
  await Effect.runPromise(worker.maintain());
  advance(61000);
  await Effect.runPromise(worker.maintain());
  expect(readVideo(context.database, actor.organizationId, video.videoId).state).toBe("deleted");
  expect(stores.public.objects.size).toBe(0);
  expect(storageUsage(context.database, storageConfig, actor.organizationId).usedBytes).toBe(0);
}, 30000);

const createHlsJobFixture = async () => {
  const context = await createJobTestContext();
  const paths = await Effect.runPromise(makeJobStoragePaths(context.mediaRoot, "job-1"));
  await Effect.runPromise(prepareJobWorkspace(paths));
  await promisify(execFile)("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x36:rate=25:duration=0.4",
    "-c:v",
    "ffv1",
    "-f",
    "matroska",
    paths.inputFile,
  ]);
  const bytes = await readFile(paths.inputFile);
  const config = {
    ...context,
    artifactAccessGrantTtlMs: 900000,
    artifactTtlMs: 86400000,
    audioSilenceThresholdDb: -50,
    maxExtractedImages: 2000,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    ffmpegVersion: "local",
    ffprobeVersion: "local",
    publicBaseUrl: "https://media.example",
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const inspector = yield* MediaInspector;
      const source = yield* normalizeSourceInspection(yield* inspector.inspect(paths.inputFile));
      queueCanonicalJob(context.database, {
        kind: "hls",
        subscriptionPlan: "basic",
        requestedOptionsJson: "{}",
        inspectionJson: JSON.stringify(source),
        inputBytes: bytes.length,
        declaredBytes: bytes.length,
        inputSha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: Date.now() - 1,
      });
      const job = claimNextJob(context.database, {
        now: Date.now(),
        leaseDurationMs: 60000,
        workerId: "hls-worker",
      });
      if (!job) throw new Error("Expected an HLS job");
      const runner = yield* MediaProcessRunner;
      const processor = makeMediaJobProcessor(context.database, config, runner);
      const analysis = yield* processor.analyze(job);
      transitionJob(context.database, {
        jobId: job.id,
        now: Date.now(),
        command: {
          type: "processing",
          attempt: job.attemptCount,
          workerId: "hls-worker",
          creditUnits: analysis.creditUnits,
          leaseDurationMs: 60000,
        },
      });
      const output = yield* analysis.process(job);
      transitionJob(context.database, {
        jobId: job.id,
        now: Date.now(),
        command: {
          type: "complete",
          attempt: job.attemptCount,
          workerId: "hls-worker",
          resultJson: JSON.stringify(output),
        },
      });
      return yield* Schema.decodeUnknownEffect(JobResultSchema)(output);
    }).pipe(
      Effect.provide(MediaInspector.layer()),
      Effect.provide(MediaProcessRunner.layer({ concurrency: 1 })),
    ),
  );
  return { context, config, paths, result };
};

const hlsStorageFixture = async (
  context: Awaited<ReturnType<typeof createHlsJobFixture>>["context"],
  config: Awaited<ReturnType<typeof createHlsJobFixture>>["config"],
) => {
  let now = Date.now();
  const actor = ensureOrganizationActor(context.database);
  const peers = new Map<string, MemoryObjectStore>();
  const stores = {
    public: new MemoryObjectStore("public", peers),
    private: new MemoryObjectStore("private", peers),
    staging: new MemoryObjectStore("staging", peers),
  };
  const storageConfig = {
    ...config,
    now: () => now,
    priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
    managedTargetId: "local-store",
    managedPublicOrigin: "https://media.example",
  };
  const service = makeVideoService(context.database, storageConfig);
  const saved = await Effect.runPromise(
    service.save({
      ...actor,
      jobId: "job-1",
      destination: { kind: "managed" },
      idempotencyKey: "hls-save",
    }),
  );
  expect(saved.video.state).toBe("storing");
  expect(saved.video).not.toHaveProperty("hls.playbackUrl");
  const workerConfig = {
    ...storageConfig,
    resolveTarget: async (id, role) => ({
      id,
      role,
      store: stores[role],
      publicOrigin: "https://media.example",
    }),
    verifyPublic: async () => undefined,
    purge: async () => undefined,
    writerIdentity: "hls-test",
    isWriterAlive: () => false,
  } satisfies Parameters<typeof makeStorageWorker>[1];
  const worker = makeStorageWorker(context.database, workerConfig);
  return {
    actor,
    stores,
    storageConfig,
    service,
    saved,
    workerConfig,
    worker,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};
