import { verifyTrimFrameTiming } from "./trim-frame-verification.ts";
import type { ResolvedCompressionOptions } from "@densio/shared";
import { Effect } from "effect";
import { resolveTrimRange } from "../media/inspection/trim-timeline.ts";
import { decodeMediaProbe } from "../media/inspection/media-probe.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import type { StagedWorkflowOutput } from "../media/workflows/workflow-types.ts";
import { resolveStagedFile, type JobStoragePaths } from "../storage/workspace.ts";
import { JobProcessorError } from "./job-worker.ts";

export const verifyTrimmedOutputs = Effect.fn("VideoJob.verifyTrimmedOutputs")(function* (
  executable: string,
  paths: JobStoragePaths,
  outputs: ReadonlyArray<StagedWorkflowOutput>,
  options: ResolvedCompressionOptions,
) {
  const expected = options.trim;
  if (!expected) return outputs;
  const runner = yield* MediaProcessRunner;
  return yield* Effect.forEach(outputs, (output) =>
    Effect.gen(function* () {
      const path = yield* resolveStagedFile(paths, output.stagedFilename);
      const metadata = yield* runner.run({
        executable,
        arguments: ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
      });
      const probe = yield* decodeMediaProbe(metadata.stdout);
      const actual = yield* resolveTrimRange(
        executable,
        path,
        { start: { kind: "frame", frame: 0 } },
        probe.videoStreamIndex,
      );
      const tolerance = Math.max(actual.timeBase.numerator / actual.timeBase.denominator, 0.001);
      if (
        options.frameRate.mode === "preserve" &&
        (actual.frameCount !== expected.frameCount ||
          Math.abs(actual.durationSeconds - expected.durationSeconds) > tolerance)
      )
        return yield* new JobProcessorError({
          code: "TRIM_OUTPUT_INVALID",
          message: "The encoded clip does not match the selected frame range.",
          details: {},
        });
      if (options.frameRate.mode === "preserve")
        yield* verifyTrimFrameTiming(
          executable,
          paths.inputFile,
          path,
          paths.stagingDirectory,
          expected,
          actual,
        );
      return {
        ...output,
        durationSeconds: actual.durationSeconds,
        width: probe.displayDimensions.width,
        height: probe.displayDimensions.height,
      };
    }),
  );
});
