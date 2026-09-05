import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedTrimRange } from "@densio/shared";
import { Effect } from "effect";
import { resolveTrimRange } from "../media/inspection/trim-timeline.ts";
import { JobProcessorError } from "./job-worker.ts";

export const verifyTrimFrameTiming = Effect.fn("VideoJob.verifyFrameTiming")(function* (
  executable: string,
  inputPath: string,
  outputPath: string,
  stagingDirectory: string,
  expected: ResolvedTrimRange,
  actual: ResolvedTrimRange,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(stagingDirectory, "trim-timing-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const descriptor = yield* Effect.acquireRelease(
        Effect.try(() => openSync(join(directory, "timestamps"), "wx+", 0o600)),
        (file) => Effect.sync(() => closeSync(file)),
      );
      const record = Buffer.alloc(8);
      // A disk-backed fixed-width record keeps verification memory independent of clip length.
      yield* resolveTrimRange(
        executable,
        inputPath,
        {
          start: { kind: "frame", frame: expected.startFrame },
          end: { kind: "frame", frame: expected.endFrame },
        },
        expected.videoStreamIndex,
        (frame, pts) => {
          if (frame < expected.startFrame || frame >= expected.endFrame) return;
          record.writeBigInt64LE(pts - BigInt(expected.startPts));
          if (writeSync(descriptor, record, 0, 8, (frame - expected.startFrame) * 8) !== 8)
            throw timingError();
        },
      );
      yield* resolveTrimRange(
        executable,
        outputPath,
        { start: { kind: "frame", frame: 0 } },
        actual.videoStreamIndex,
        (frame, pts) => {
          if (readSync(descriptor, record, 0, 8, frame * 8) !== 8) throw timingError();
          const source =
            record.readBigInt64LE() *
            BigInt(expected.timeBase.numerator) *
            BigInt(actual.timeBase.denominator);
          const output =
            (pts - BigInt(actual.startPts)) *
            BigInt(actual.timeBase.numerator) *
            BigInt(expected.timeBase.denominator);
          const difference = source > output ? source - output : output - source;
          const tolerance =
            BigInt(actual.timeBase.numerator) * BigInt(expected.timeBase.denominator);
          if (difference > tolerance) throw timingError();
        },
      );
    }),
  );
});

const timingError = () =>
  new JobProcessorError({
    code: "TRIM_OUTPUT_INVALID",
    message: "Encoded frame timing differs from the selected source interval.",
    details: {},
  });
