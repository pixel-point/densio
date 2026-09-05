import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it } from "vitest";
import { artifacts } from "../src/database/schema.ts";
import { claimNextJob } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { makeMediaJobProcessor } from "../src/jobs/media-job-adapter.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";
import { createJobTestContext, cleanupJobFixtures, queueCanonicalJob } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);
it.each(["trim", "compress"] as const)(
  "publishes a verified %s clip using the exact reserved quote",
  async (kind) => {
    const context = await createJobTestContext();
    const now = 1_800_000_000_000;
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        const runner = yield* MediaProcessRunner;
        const inspector = yield* MediaInspector;
        const paths = yield* makeJobStoragePaths(context.mediaRoot, "job-1");
        yield* prepareJobWorkspace(paths);
        yield* createInput(runner, paths.inputFile);
        const inspection = yield* inspector
          .inspect(paths.inputFile)
          .pipe(Effect.flatMap(normalizeSourceInspection));
        const trim = {
          start: { kind: "frame" as const, frame: 3 },
          end: { kind: "frame" as const, frame: 8 },
        };
        const resolvedTrim = yield* inspector.resolveTrimRange(paths.inputFile, trim, 0);
        const bytes = yield* Effect.promise(() => readFile(paths.inputFile));
        queueCanonicalJob(context.database, {
          kind,
          sourceFilename: "input.mkv",
          inspectionJson: JSON.stringify(inspection),
          requestedOptionsJson: JSON.stringify(
            kind === "trim"
              ? { trim, output: { codec: "vp9" } }
              : { trim, codecs: ["vp9"], bitDepth: 10 },
          ),
          resolvedOptionsJson: JSON.stringify(
            kind === "trim"
              ? { trim: resolvedTrim, output: { codec: "vp9", crf: 42 }, audio: "remove" }
              : {
                  bitDepth: 10,
                  trim: resolvedTrim,
                  codecs: ["vp9"],
                  crf: { vp9: 42 },
                  audio: "remove",
                  frameRate: { mode: "preserve" },
                },
          ),
          declaredBytes: bytes.length,
          inputBytes: bytes.length,
          inputSha256: createHash("sha256").update(bytes).digest("hex"),
          createdAt: now - 2,
        });
        const job = claimNextJob(context.database, {
          now,
          leaseDurationMs: 60000,
          workerId: "worker-1",
        });
        if (!job) throw new Error("Expected a job");
        const processor = makeMediaJobProcessor(
          context.database,
          {
            mediaRoot: context.mediaRoot,
            publicBaseUrl: "https://densio.test",
            ffmpegPath: "ffmpeg",
            ffprobePath: "ffprobe",
            ffmpegVersion: "test",
            ffprobeVersion: "test",
            artifactAccessGrantTtlMs: 900000,
            artifactTtlMs: 86400000,
            audioSilenceThresholdDb: -50,
            maxExtractedImages: 2000,
          },
          runner,
        );
        const analysis = yield* processor.analyze(job);
        expect(analysis.creditUnits).toBe(job.quoteCreditUnits);
        transitionJob(context.database, {
          jobId: job.id,
          now,
          command: {
            type: "processing",
            attempt: job.attemptCount,
            workerId: "worker-1",
            creditUnits: analysis.creditUnits,
            leaseDurationMs: 60000,
          },
        });
        const result = yield* analysis.process(job);
        expect(result).toMatchObject({ kind, artifactIds: [expect.any(String)] });
        const output = context.database.db.select().from(artifacts).get();
        expect(output).toMatchObject({ durationSeconds: 0.5, width: 64, height: 64 });
        yield* verifyClipOutput(inspector, output!.path, kind === "compress" ? 10 : 8);
      }).pipe(
        Effect.provide(
          MediaInspector.layer({}).pipe(
            Layer.provideMerge(MediaProcessRunner.layer({ concurrency: 2 })),
          ),
        ),
        Effect.provide(TestClock.layer()),
      ),
    );
  },
);

const verifyClipOutput = Effect.fn("TrimTest.verifyClipOutput")(function* (
  inspector: MediaInspector["Service"],
  path: string,
  bitDepth: 8 | 10,
) {
  expect((yield* inspector.inspect(path)).videoProperties?.pixelFormat).toBe(
    bitDepth === 10 ? "yuv420p10le" : "yuv420p",
  );
  expect(
    yield* inspector.resolveTrimRange(path, { start: { kind: "frame", frame: 0 } }, 0),
  ).toMatchObject({ frameCount: 5 });
});

const createInput = Effect.fn("TrimTest.createInput")(function* (
  runner: MediaProcessRunner["Service"],
  inputPath: string,
) {
  yield* runner.run({
    executable: "ffmpeg",
    arguments: [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=10:duration=2",
      "-c:v",
      "ffv1",
      "-f",
      "matroska",
      inputPath,
    ],
  });
});
