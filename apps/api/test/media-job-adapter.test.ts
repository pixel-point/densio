import { access, chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { JobResultSchema } from "@ffmpeg-api/shared";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { artifacts, jobs, mediaCommands, users } from "../src/database/schema.ts";
import {
  type MediaJobAdapterConfig,
  makeMediaJobCleanup,
  makeMediaJobProcessor,
} from "../src/jobs/media-job-adapter.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";

const NOW = 1_800_000_000_000;
const fixtureSource = fileURLToPath(new URL("./fixtures/media-job-fixture.mjs", import.meta.url));
const temporaryRoots: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

it("inspects, compresses, publishes, registers, diagnoses, and cleans a job", async () => {
  const context = await createContext("compress", {}, { duration: 6 });
  const rawResult = await runProcessor(context);
  const result = Schema.decodeUnknownSync(JobResultSchema)(rawResult);

  expect(result.kind).toBe("compress");
  if (result.kind !== "compress") throw new Error("Expected compression result.");
  expect(result.artifacts).toHaveLength(2);
  expect(result.html).toContain('<source src="https://media.example/v1/artifacts/');
  expect(result.html).toContain('type="video/webm"');
  expect(result.commands).toHaveLength(2);
  expect(context.database.db.select().from(artifacts).all()).toHaveLength(2);
  expect(context.database.db.select().from(mediaCommands).all()).toHaveLength(3);
  expect(
    context.database.db.select({ tool: mediaCommands.tool }).from(mediaCommands).all(),
  ).toEqual([{ tool: "ffprobe" }, { tool: "ffmpeg" }, { tool: "ffmpeg" }]);
  await Promise.all(
    result.artifacts.map((artifact) => access(artifactPath(context, artifact.filename))),
  );

  context.database.db
    .update(jobs)
    .set({ state: "succeeded" })
    .where(eq(jobs.id, context.job.id))
    .run();
  const succeeded = context.database.db
    .select()
    .from(jobs)
    .where(eq(jobs.id, context.job.id))
    .get();
  if (succeeded === undefined) throw new Error("Expected persisted job.");
  await Effect.runPromise(makeMediaJobCleanup(context.database, context.config).cleanup(succeeded));

  await expect(access(context.paths.inputFile)).rejects.toMatchObject({ code: "ENOENT" });
  await Promise.all(
    result.artifacts.map((artifact) => access(artifactPath(context, artifact.filename))),
  );
  context.database.close();
});

it("extracts an image archive through the durable media adapter", async () => {
  const context = await createContext(
    "extract-images",
    { format: "png", intervalSeconds: 2 },
    { duration: 6 },
  );
  const rawResult = await runProcessor(context);
  const result = Schema.decodeUnknownSync(JobResultSchema)(rawResult);

  expect(result.kind).toBe("extract-images");
  if (result.kind !== "extract-images") throw new Error("Expected extraction result.");
  expect(result).toMatchObject({ imageCount: 3, intervalSeconds: 2 });
  expect(result.archive).toMatchObject({
    filename: "images.zip",
    kind: "image-archive",
    mediaType: "application/zip",
  });
  await expect(access(artifactPath(context, result.archive.filename))).resolves.toBeUndefined();
  expect(context.database.db.select().from(artifacts).all()).toHaveLength(1);
  expect(context.database.db.select().from(mediaCommands).all()).toHaveLength(2);
  context.database.close();
});

it("renders and registers near-EOF quality comparison variants", async () => {
  const context = await createContext(
    "compare-quality",
    {
      codec: "vp9",
      crfs: [30, 40],
      durationSeconds: 1,
      position: { kind: "seconds", seconds: 5.5 },
    },
    { duration: 6 },
  );
  const rawResult = await runProcessor(context);
  const result = Schema.decodeUnknownSync(JobResultSchema)(rawResult);

  expect(result.kind).toBe("compare-quality");
  if (result.kind !== "compare-quality") throw new Error("Expected comparison result.");
  expect(result).toMatchObject({
    actualSampleDurationSeconds: 0.5,
    codec: "vp9",
    normalizedStartSeconds: 5.5,
    variants: [
      { crf: 30, estimatedFullVideoBytes: 3_600, sampleBytes: 300 },
      { crf: 40, estimatedFullVideoBytes: 4_800, sampleBytes: 400 },
    ],
  });
  expect(context.database.db.select().from(artifacts).all()).toHaveLength(4);
  expect(context.database.db.select().from(mediaCommands).all()).toHaveLength(5);
  await Promise.all(
    result.variants.flatMap((variant) => [
      access(artifactPath(context, variant.preview.filename)),
      access(artifactPath(context, variant.still.filename)),
    ]),
  );
  context.database.close();
});

it("rolls back artifact rows and cleanup removes files after registration fails", async () => {
  const context = await createContext("compress", {}, { duration: 6 });
  context.database.sqlite.exec(`
    create trigger fail_h265_registration
    before insert on artifacts
    when NEW.filename = 'video-h265.mp4'
    begin
      select raise(abort, 'deterministic registration failure');
    end
  `);

  const error = await Effect.runPromise(Effect.flip(processorProgram(context)));

  expect(error).toMatchObject({ code: "MEDIA_JOB_FAILED" });
  expect(context.database.db.select().from(artifacts).all()).toEqual([]);
  await expect(access(artifactPath(context, "video-vp9.webm"))).resolves.toBeUndefined();
  await expect(access(artifactPath(context, "video-h265.mp4"))).resolves.toBeUndefined();
  context.database.db
    .update(jobs)
    .set({ state: "failed" })
    .where(eq(jobs.id, context.job.id))
    .run();
  const failed = context.database.db.select().from(jobs).where(eq(jobs.id, context.job.id)).get();
  if (failed === undefined) throw new Error("Expected failed job.");
  await Effect.runPromise(makeMediaJobCleanup(context.database, context.config).cleanup(failed));

  await expect(access(context.paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(context.paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.stringify(context.database.db.select().from(mediaCommands).all())).not.toContain(
    "/v1/artifacts/",
  );
  context.database.close();
});

it("persists sanitized bounded diagnostics for a failed media command", async () => {
  const context = await createContext("compress", {}, { duration: 6, failCodec: "h265" });

  const error = await Effect.runPromise(Effect.flip(processorProgram(context)));
  const commands = context.database.db.select().from(mediaCommands).all();

  expect(error).toMatchObject({
    code: "MEDIA_PROCESS_FAILED",
    details: { stderrTail: "deterministic media job failure" },
  });
  expect(commands).toHaveLength(3);
  expect(commands.at(-1)).toMatchObject({
    exitCode: 9,
    stderrTail: "deterministic media job failure",
  });
  [JSON.stringify(commands), JSON.stringify(error)].forEach((diagnostic) => {
    expect(diagnostic).not.toContain(String.fromCharCode(0));
    expect(diagnostic).not.toContain(String.fromCharCode(27));
  });
  context.database.close();
});

it("analyzes audible audio and retains it in both default outputs", async () => {
  const context = await createContext("compress", {}, { audio: "-30", duration: 6 });
  const result = Schema.decodeUnknownSync(JobResultSchema)(await runProcessor(context));

  expect(result.kind).toBe("compress");
  if (result.kind !== "compress") throw new Error("Expected compression result.");
  expect(result.commands).toHaveLength(2);
  result.commands.forEach((command) => {
    expect(command.arguments).toContain("0:a:0");
    expect(command.arguments).not.toContain("-an");
  });
  expect(context.database.db.select().from(mediaCommands).all()).toHaveLength(4);
  context.database.close();
});

it("allows AV1 for a free job", async () => {
  const context = await createContext("compress", { codecs: ["av1"] }, { duration: 6 });
  const result = Schema.decodeUnknownSync(JobResultSchema)(await runProcessor(context));

  expect(result).toMatchObject({ artifacts: [{ codec: "av1" }], kind: "compress" });
  expect(context.database.db.select().from(mediaCommands).all()).toHaveLength(2);
  expect(context.database.db.select().from(artifacts).all()).toHaveLength(1);
  context.database.close();
});

it.each([
  ["one H.265 output", { codecs: ["h265"] }, 100],
  ["the default VP9 and H.265 outputs", {}, 200],
] as const)("meters five-minute 1080p compression for %s", async (_label, options, expected) => {
  const context = await createContext("compress", options, {
    duration: 300,
    height: 1080,
    width: 1920,
  });

  const analysis = await Effect.runPromise(
    MediaProcessRunner.use((runner) =>
      makeMediaJobProcessor(context.database, context.config, runner).analyze(context.job),
    ).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 3 }))),
  );

  expect(analysis.creditUnits).toBe(expected);
  expect(analysis.data).toMatchObject({ kind: "compress" });
  context.database.close();
});

it.each([
  ["free", 1_800.01],
  ["pro", 1_800.01],
] as const)("enforces the %s duration limit", async (plan, duration) => {
  const context = await createContext("compress", {}, { duration }, plan);

  const error = await Effect.runPromise(Effect.flip(processorProgram(context)));

  expect(error).toMatchObject({ code: "DURATION_LIMIT_EXCEEDED" });
  expect(context.database.db.select().from(mediaCommands).all()).toHaveLength(1);
  context.database.close();
});

it("rejects analysis from a different job attempt", async () => {
  const context = await createContext("compress", {}, { duration: 6 });
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* MediaProcessRunner.use((runner) => {
        const processor = makeMediaJobProcessor(context.database, context.config, runner);
        return Effect.gen(function* () {
          const analysis = yield* processor.analyze(context.job);
          return yield* Effect.flip(
            processor.process({ ...context.job, attemptCount: 2 }, analysis.data),
          );
        });
      });
    }).pipe(
      Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })),
      Effect.provide(TestClock.layer()),
    ),
  );

  expect(error).toMatchObject({ code: "STALE_JOB_ANALYSIS" });
  expect(JSON.stringify(error)).not.toContain("/v1/artifacts/");
  context.database.close();
});

it.each([
  ["compress", {}],
  ["extract-images", {}],
  ["compare-quality", { codec: "vp9", crfs: [30, 40] }],
] as const)("persists workflow-discriminated analysis for %s", async (kind, options) => {
  const context = await createContext(kind, options, { duration: 6 });
  const analysis = await Effect.runPromise(
    MediaProcessRunner.use((runner) =>
      makeMediaJobProcessor(context.database, context.config, runner).analyze(context.job),
    ).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 3 }))),
  );

  expect(analysis).toMatchObject({ creditUnits: 5, data: { kind } });
  context.database.close();
});

const runProcessor = (context: TestContext) => Effect.runPromise(processorProgram(context));

const processorProgram = (context: TestContext) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    return yield* MediaProcessRunner.use((runner) => {
      const processor = makeMediaJobProcessor(context.database, context.config, runner);
      return Effect.gen(function* () {
        const analysis = yield* processor.analyze(context.job);
        return yield* processor.process(context.job, analysis.data);
      });
    });
  }).pipe(
    Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })),
    Effect.provide(TestClock.layer()),
  );

interface TestContext {
  readonly config: MediaJobAdapterConfig;
  readonly database: Database;
  readonly job: typeof jobs.$inferSelect;
  readonly paths: Awaited<ReturnType<typeof makePaths>>;
}

const createContext = async (
  kind: typeof jobs.$inferInsert.kind,
  options: Schema.Json,
  source: Schema.Json,
  plan: "free" | "pro" = "free",
): Promise<TestContext> => {
  const root = await mkdtemp(join(tmpdir(), "ffmpeg-api-media-job-"));
  temporaryRoots.push(root);
  const database = openDatabase(join(root, "database.sqlite"));
  migrateDatabase(database);
  const paths = await makePaths(root, "job-1");
  await writeFile(paths.inputFile, JSON.stringify(source));
  const config = await makeConfig(root);
  database.db
    .insert(users)
    .values({ createdAt: NOW, email: "agent@example.com", id: "user-1", updatedAt: NOW })
    .run();
  database.db
    .insert(jobs)
    .values(jobValues(kind, options, plan))
    .run();
  const job = database.db.select().from(jobs).get();
  if (job === undefined) throw new Error("Expected test job.");
  return { config, database, job, paths };
};

const makePaths = async (root: string, jobId: string) => {
  const paths = await Effect.runPromise(makeJobStoragePaths(join(root, "media"), jobId));
  await Effect.runPromise(prepareJobWorkspace(paths));
  return paths;
};

const makeConfig = async (root: string): Promise<MediaJobAdapterConfig> => {
  const ffmpegPath = join(root, "ffmpeg");
  const ffprobePath = join(root, "ffprobe");
  await Promise.all([copyExecutable(ffmpegPath), copyExecutable(ffprobePath)]);
  return {
    artifactTtlMs: 86_400_000,
    audioSilenceThresholdDb: -50,
    ffmpegPath,
    ffprobePath,
    maxExtractedImages: 2_000,
    mediaRoot: join(root, "media"),
    publicBaseUrl: "https://media.example",
  };
};

const copyExecutable = async (path: string) => {
  await copyFile(fixtureSource, path);
  await chmod(path, 0o755);
};

const artifactPath = (context: TestContext, filename: string) =>
  join(context.paths.artifactDirectory, filename);

const jobValues = (
  kind: typeof jobs.$inferInsert.kind,
  options: Schema.Json,
  plan: "free" | "pro",
) => ({
  attemptCount: 1,
  createdAt: NOW,
  declaredBytes: 100,
  id: "job-1",
  kind,
  optionsJson: JSON.stringify(options),
  plan,
  sourceFilename: "input.mp4",
  state: "processing" as const,
  updatedAt: NOW,
  userId: "user-1",
});
