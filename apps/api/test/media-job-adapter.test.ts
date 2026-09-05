import { createHash } from "node:crypto";
import { access, chmod, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExecutionPlanCreateRequestSchema,
  JobResultSchema,
  type ExecutionPlanCreateRequest,
  type Plan,
} from "@densio/shared";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it } from "vitest";

import { claimNextJob, recoverExpiredJobs } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { artifactAccessGrants, artifacts, jobs, mediaCommands } from "../src/database/schema.ts";
import {
  makeMediaJobCleanup,
  makeMediaJobProcessor,
  type MediaJobAdapterConfig,
} from "../src/jobs/media-job-adapter.ts";
import { prepareJobExecution } from "../src/jobs/media-job-handler-support.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";
import { createJobTestContext, cleanupJobFixtures, queueCanonicalJob } from "./job-fixture.ts";

const NOW = 1_800_000_000_000;
const fixtureSource = fileURLToPath(new URL("./fixtures/media-job-fixture.mjs", import.meta.url));
const variants = [
  { codec: "vp9", crf: 30 },
  { codec: "h265", crf: 32 },
] as const;
afterEach(cleanupJobFixtures);

it("isolates retry scratch and publication paths while sharing the attached input", async () => {
  const context = await createContext("compress", {});
  const [first, retry] = await Effect.runPromise(
    MediaProcessRunner.use((runner) =>
      Effect.all([
        prepareJobExecution({ ...context, runner }, context.job),
        prepareJobExecution({ ...context, runner }, { ...context.job, attemptCount: 2 }),
      ]),
    ).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 3 }))),
  );
  expect(first.paths.inputFile).toBe(retry.paths.inputFile);
  expect(first.paths.stagingDirectory).not.toBe(retry.paths.stagingDirectory);
  expect(first.paths.artifactDirectory).not.toBe(retry.paths.artifactDirectory);
});

it("executes the planned compression and freezes evidence without creating access grants", async () => {
  const context = await createContext("compress", {});
  const result = await runProcessor(context);
  expect(result.kind).toBe("compress");
  if (result.kind !== "compress") throw new Error("Expected compression");
  const outputs = context.database.db.select().from(artifacts).all();
  expect(result.artifactIds).toEqual(outputs.map(({ id }) => id));
  expect(outputs).toHaveLength(2);
  expect(outputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        durationSeconds: 6,
        height: 360,
        width: 640,
        retainedUntil: NOW + 86_400_000,
      }),
    ]),
  );
  expect(result.html).toContain('<source src="./video-vp9.webm"');
  expect(result).not.toHaveProperty("previewHtml");
  expect(result).not.toHaveProperty("commands");
  expect(context.database.db.select().from(artifactAccessGrants).all()).toEqual([]);
  const stored = currentJob(context);
  const receipt = JSON.parse(stored.receiptJson ?? "null");
  expect(receipt.execution).toMatchObject({
    ffmpegVersion: "fixture-ffmpeg",
    ffprobeVersion: "fixture-ffprobe",
  });
  expect(
    context.database.db.select({ tool: mediaCommands.tool }).from(mediaCommands).all(),
  ).toEqual([{ tool: "ffprobe" }, { tool: "ffmpeg" }, { tool: "ffmpeg" }]);
  await Effect.runPromise(makeMediaJobCleanup(context.database, context.config).cleanup(stored));
  await expect(access(context.paths.inputFile)).rejects.toMatchObject({ code: "ENOENT" });
  await Promise.all(outputs.map(({ path }) => access(path)));
});

it("recovers a crash after publication into one authoritative artifact set", async () => {
  const context = await createContext("compress", {});
  await Effect.runPromise(processorProgram(context));
  const firstIds = context.database.db.select({ id: artifacts.id }).from(artifacts).all();
  const firstPaths = context.database.db.select({ path: artifacts.path }).from(artifacts).all();
  expect(currentJob(context).state).toBe("publishing");
  recoverExpiredJobs(context.database, { now: NOW + 60_001, maxAttempts: 2 });
  const retry = claimNextJob(context.database, {
    now: NOW + 60_002,
    leaseDurationMs: 60_000,
    workerId: "worker-2",
  });
  if (retry === undefined) throw new Error("Expected retry");
  await runProcessor({ ...context, job: retry, now: NOW + 60_003 });
  const outputs = context.database.db.select().from(artifacts).all();
  expect(outputs).toHaveLength(2);
  expect(outputs.map(({ id }) => ({ id }))).not.toEqual(expect.arrayContaining(firstIds));
  expect(context.database.db.select().from(artifactAccessGrants).all()).toEqual([]);
  expect(currentJob(context).attemptCount).toBe(2);
  await Effect.runPromise(
    makeMediaJobCleanup(context.database, context.config).cleanup(currentJob(context)),
  );
  await Promise.all(outputs.map(({ path }) => access(path)));
  await Promise.all(
    firstPaths.map(async ({ path }) => {
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    }),
  );
});

it("extracts images using resolved dimensions, interval, and stable archive identity", async () => {
  const context = await createContext("extract-images", { format: "png", intervalSeconds: 2 });
  const result = await runProcessor(context);
  expect(result).toMatchObject({ kind: "extract-images", imageCount: 3, intervalSeconds: 2 });
  if (result.kind !== "extract-images") throw new Error("Expected extraction");
  const archive = context.database.db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, result.archiveArtifactId))
    .get();
  expect(archive).toMatchObject({
    filename: "images.zip",
    kind: "image-archive",
    width: 640,
    height: 360,
  });
  await expect(access(archive?.path ?? "")).resolves.toBeUndefined();
});

it("executes one near-EOF sample with low-confidence comparison evidence", async () => {
  const context = await createContext("compare-quality", {
    variants,
    samples: { mode: "positions", positions: [{ kind: "seconds", seconds: 5.5 }] },
  });
  const result = await runProcessor(context);
  expect(result).toMatchObject({
    kind: "compare-quality",
    samples: [{ normalizedStartSeconds: 5.5, actualSampleDurationSeconds: 0.5 }],
    decision: { confidence: "low", confidenceBasis: { sampleCount: 1, independentSampleCount: 1 } },
  });
  expect(context.database.db.select().from(artifacts).all()).toHaveLength(4);
});

it("resolves frame selectors during planning and never repeats them during execution", async () => {
  const context = await createContext(
    "compare-quality",
    {
      variants,
      objectiveMetrics: ["ssim", "psnr"],
      durationSeconds: 2,
      samples: {
        mode: "positions",
        positions: [
          { kind: "seconds", seconds: 1 },
          { kind: "frame", frame: 24 },
        ],
      },
    },
    { duration: 6, frameTimestamp: 3.25 },
  );
  const result = await runProcessor(context);
  expect(result).toMatchObject({
    kind: "compare-quality",
    samples: [
      { sampleId: "sample-1", normalizedStartSeconds: 1, actualSampleDurationSeconds: 2 },
      { sampleId: "sample-2", normalizedStartSeconds: 3.25, actualSampleDurationSeconds: 2 },
    ],
    variants: [
      { codec: "vp9", metrics: { ssim: 0.97, psnr: 35 } },
      { codec: "h265", metrics: { ssim: 0.968, psnr: 34 } },
    ],
    decision: { confidence: "medium", recommendedVariantId: "variant-vp9-crf-30" },
  });
  expect(commands(context).some(({ arguments: argv }) => argv.includes("-show_frames"))).toBe(
    false,
  );
  expect(commands(context)).toHaveLength(10);
});

it("rejects all encoded outputs before publication when their aggregate exceeds the guard", async () => {
  const context = await createContext("compress", {});
  const error = await Effect.runPromise(
    Effect.flip(processorProgram({ ...context, job: { ...context.job, maxOutputBytes: 1 } })),
  );
  expect(error).toMatchObject({ code: "OUTPUT_SIZE_LIMIT_EXCEEDED", details: { limitBytes: 1 } });
  expect(context.database.db.select().from(artifacts).all()).toEqual([]);
  await expect(access(context.paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rolls back registration atomically and cleanup removes unpublished residue", async () => {
  const context = await createContext("compress", {});
  context.database.sqlite.exec(
    "create trigger reject_registration before insert on artifacts when NEW.filename = 'video-h265.mp4' begin select raise(abort, 'registration failure'); end",
  );
  expect(await Effect.runPromise(Effect.flip(processorProgram(context)))).toMatchObject({
    code: "MEDIA_JOB_FAILED",
  });
  expect(context.database.db.select().from(artifacts).all()).toEqual([]);
  transitionJob(context.database, {
    jobId: context.job.id,
    now: NOW,
    command: {
      type: "fail",
      workerId: "worker-1",
      attempt: 1,
      code: "MEDIA_JOB_FAILED",
      message: "Registration failed",
      details: {},
    },
  });
  await Effect.runPromise(
    makeMediaJobCleanup(context.database, context.config).cleanup(currentJob(context)),
  );
  await expect(access(context.paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(context.paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves bounded, sanitized diagnostics for failed FFmpeg commands", async () => {
  const context = await createContext("compress", {}, { duration: 6, failCodec: "h265" });
  expect(await Effect.runPromise(Effect.flip(processorProgram(context)))).toMatchObject({
    code: "MEDIA_PROCESS_FAILED",
    details: { stderrTail: "deterministic media job failure" },
  });
  const rows = context.database.db.select().from(mediaCommands).all();
  expect(rows).toHaveLength(3);
  expect(rows.at(-1)).toMatchObject({ exitCode: 9, stderrTail: "deterministic media job failure" });
  expect(JSON.stringify(rows)).not.toContain(String.fromCharCode(27));
});

it("detects changed source inspection before encoding", async () => {
  const context = await createContext("compress", {});
  await writeFile(context.paths.inputFile, JSON.stringify({ duration: 7 }));
  expect(await Effect.runPromise(Effect.flip(processorProgram(context)))).toMatchObject({
    code: "PLAN_DIVERGED",
  });
  expect(context.database.db.select().from(artifacts).all()).toEqual([]);
  expect(commands(context)).toHaveLength(1);
  expect(JSON.parse(currentJob(context).toolchainJson ?? "null")).toEqual({
    ffmpegVersion: "fixture-ffmpeg",
    ffprobeVersion: "fixture-ffprobe",
  });
});

it("rejects analysis from another worker attempt", async () => {
  const context = await createContext("compress", {});
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* MediaProcessRunner.use((runner) =>
        Effect.gen(function* () {
          const processor = makeMediaJobProcessor(context.database, context.config, runner);
          const analysis = yield* processor.analyze(context.job);
          return yield* Effect.flip(analysis.process({ ...context.job, attemptCount: 2 }));
        }),
      );
    }).pipe(
      Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })),
      Effect.provide(TestClock.layer()),
    ),
  );
  expect(error).toMatchObject({ code: "STALE_JOB_ANALYSIS" });
});

it.each([
  [{ audio: "auto" }, { audio: "-30", duration: 6 }, "0:a:0"],
  [
    { frameRate: { mode: "cap", maximum: 30 } },
    { frameRate: "60000/1001", duration: 6 },
    "fps=30000/1001",
  ],
] as const)(
  "applies resolved audio and frame-rate policy to every output",
  async (options, source, argument) => {
    const context = await createContext("compress", options, source);
    await runProcessor(context);
    const encodes = commands(context).filter(({ arguments: argv }) => argv.includes("-crf"));
    expect(encodes).toHaveLength(2);
    encodes.forEach(({ arguments: argv }) => expect(argv).toContain(argument));
  },
);

it("rejects an unentitled codec before creating a job and permits it on Basic", async () => {
  await expect(createContext("compress", { codecs: ["av1"] })).rejects.toMatchObject({
    _tag: "ExecutionPlanEntitlementRejected",
  });
  const context = await createContext("compress", { codecs: ["av1"] }, { duration: 6 }, "basic");
  await runProcessor(context);
  expect(context.database.db.select().from(artifacts).all()).toMatchObject([{ codec: "av1" }]);
});

it.each([
  [{ codecs: ["h265"] }, 100],
  [{}, 200],
] as const)("meters the exact five-minute 1080p plan cost", async (options, expected) => {
  const context = await createContext("compress", options, {
    duration: 300,
    height: 1080,
    width: 1920,
  });
  expect(context.job.quoteCreditUnits).toBe(expected);
  const analysis = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* MediaProcessRunner.use((runner) =>
        makeMediaJobProcessor(context.database, context.config, runner).analyze(context.job),
      );
    }).pipe(
      Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })),
      Effect.provide(TestClock.layer()),
    ),
  );
  expect(analysis.creditUnits).toBe(expected);
});

const createContext = async (
  workflow: ExecutionPlanCreateRequest["workflow"],
  options: Schema.Json,
  source: Schema.Json = { duration: 6 },
  plan: Plan = "free",
) => {
  const context = await createJobTestContext();
  const paths = await Effect.runPromise(makeJobStoragePaths(context.mediaRoot, "job-1"));
  await Effect.runPromise(prepareJobWorkspace(paths));
  const bytes = JSON.stringify(source);
  await writeFile(paths.inputFile, bytes);
  const ffmpegPath = join(context.directory, "ffmpeg");
  const ffprobePath = join(context.directory, "ffprobe");
  await Promise.all(
    [ffmpegPath, ffprobePath].map(async (path) => {
      await copyFile(fixtureSource, path);
      await chmod(path, 0o755);
    }),
  );
  const config: MediaJobAdapterConfig = {
    ffmpegPath,
    ffprobePath,
    ffmpegVersion: "fixture-ffmpeg",
    ffprobeVersion: "fixture-ffprobe",
    artifactAccessGrantTtlMs: 900_000,
    artifactTtlMs: 86_400_000,
    audioSilenceThresholdDb: -50,
    maxExtractedImages: 2_000,
    mediaRoot: context.mediaRoot,
    publicBaseUrl: "https://media.example",
  };
  const request = Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema)({
    sourceId: "source-job-1",
    workflow,
    options,
  });
  const facts = await Effect.runPromise(
    MediaInspector.use((inspector) =>
      Effect.gen(function* () {
        const inspection = yield* inspector
          .inspect(paths.inputFile)
          .pipe(Effect.flatMap(normalizeSourceInspection));
        const frames =
          request.workflow === "compare-quality" && request.options.samples?.mode === "positions"
            ? request.options.samples.positions.flatMap((position) =>
                position.kind === "frame" ? [position.frame] : [],
              )
            : [];
        const timestamps = yield* Effect.forEach(frames, (frame) =>
          inspector.resolveFrameTimestamp(
            paths.inputFile,
            frame,
            inspection.primaryVideoStream.index,
          ),
        );
        return { inspection, timestamps };
      }),
    ).pipe(
      Effect.provide(MediaInspector.layer(config)),
      Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })),
    ),
  );
  queueCanonicalJob(
    context.database,
    {
      kind: workflow,
      requestedOptionsJson: JSON.stringify(options),
      subscriptionPlan: plan,
      inspectionJson: JSON.stringify(facts.inspection),
      inputBytes: Buffer.byteLength(bytes),
      declaredBytes: Buffer.byteLength(bytes),
      inputSha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: NOW - 2,
    },
    facts.timestamps,
  );
  const job = claimNextJob(context.database, {
    now: NOW,
    leaseDurationMs: 60_000,
    workerId: "worker-1",
  });
  if (job === undefined) throw new Error("Expected claimed job");
  return { ...context, config, job, paths, now: NOW };
};
type TestContext = Awaited<ReturnType<typeof createContext>>;

const processorProgram = (context: TestContext) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(context.now);
    return yield* MediaProcessRunner.use((runner) =>
      Effect.gen(function* () {
        const processor = makeMediaJobProcessor(context.database, context.config, runner);
        const analysis = yield* processor.analyze(context.job);
        const processing = transitionJob(context.database, {
          jobId: context.job.id,
          now: context.now,
          command: {
            type: "processing",
            attempt: context.job.attemptCount,
            workerId: context.job.leaseOwner ?? "",
            creditUnits: analysis.creditUnits,
            leaseDurationMs: 60_000,
          },
        });
        if (processing?.state !== "processing") return yield* Effect.die("Expected processing");
        return yield* analysis.process(context.job);
      }),
    );
  }).pipe(
    Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })),
    Effect.provide(TestClock.layer()),
  );

const runProcessor = async (context: TestContext) => {
  const result = Schema.decodeUnknownSync(JobResultSchema)(
    await Effect.runPromise(processorProgram(context)),
  );
  transitionJob(context.database, {
    jobId: context.job.id,
    now: context.now,
    command: {
      type: "complete",
      attempt: context.job.attemptCount,
      workerId: context.job.leaseOwner ?? "",
      resultJson: JSON.stringify(result),
    },
  });
  return result;
};
const currentJob = (context: TestContext) => {
  const job = context.database.db.select().from(jobs).where(eq(jobs.id, context.job.id)).get();
  if (job === undefined) throw new Error("Expected persisted job");
  return job;
};
const commands = (context: TestContext) =>
  context.database.db
    .select()
    .from(mediaCommands)
    .all()
    .map((row) => ({
      arguments: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
        row.argumentsJson,
      ),
      tool: row.tool,
    }));
