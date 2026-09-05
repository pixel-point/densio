import { resolveTrimRange } from "./trim-timeline.ts";
import type { TrimRange, ResolvedTrimRange } from "@densio/shared";
import { Context, Effect, Layer } from "effect";

import {
  type MediaProcessCommand,
  type MediaProcessError,
  MediaProcessRunner,
} from "../process/media-process-runner.ts";
import {
  buildAudioAnalysisCommand,
  type AudioClassification,
  decodeAudioAnalysis,
} from "./audio-analysis.ts";
import { decodeMediaCapabilities, type MediaCapabilities } from "./media-capabilities.ts";
import { MediaInspectionError } from "./media-inspection-error.ts";
import { decodeMediaProbe, type MediaProbe } from "./media-probe.ts";
import { decodeFrameTimestamp } from "./frame-timestamp.ts";

export interface MediaInspectorOptions {
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly silenceThresholdDb?: number;
}

type InspectorError = MediaInspectionError | MediaProcessError;

export class MediaInspector extends Context.Service<
  MediaInspector,
  {
    checkCapabilities(): Effect.Effect<MediaCapabilities, InspectorError>;
    inspect(inputPath: string): Effect.Effect<MediaProbe, InspectorError>;
    resolveTrimRange(
      inputPath: string,
      range: TrimRange,
      videoStreamIndex: number,
    ): Effect.Effect<ResolvedTrimRange, unknown>;
    resolveFrameTimestamp(
      inputPath: string,
      frameIndex: number,
      videoStreamIndex: number,
    ): Effect.Effect<number, InspectorError>;
    classifyAudio(
      inputPath: string,
      audioStreamIndexes: ReadonlyArray<number>,
      trim?: ResolvedTrimRange,
    ): Effect.Effect<AudioClassification, InspectorError>;
  }
>()("densio/media/MediaInspector") {
  static readonly layer = (options: MediaInspectorOptions = {}) =>
    Layer.effect(
      MediaInspector,
      Effect.gen(function* () {
        const runner = yield* MediaProcessRunner;
        const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
        const ffprobePath = options.ffprobePath ?? "ffprobe";
        const threshold = options.silenceThresholdDb ?? -50;
        const runComplete = Effect.fn("MediaInspector.runComplete")(function* (
          command: MediaProcessCommand,
        ) {
          const process = yield* runner.run(command);
          if (process.stdoutTruncated) {
            return yield* new MediaInspectionError({
              message: "A media inspection process produced truncated output.",
              reason: "truncated-process-output",
            });
          }

          return process.stdout;
        });
        const checkCapabilities = makeCapabilityCheck(runComplete, ffmpegPath, ffprobePath);
        const inspect = Effect.fn("MediaInspector.inspect")(function* (inputPath: string) {
          const output = yield* runComplete(mediaProbeCommand(ffprobePath, inputPath));
          return yield* decodeMediaProbe(output);
        });
        const resolveFrameTimestamp = Effect.fn("MediaInspector.resolveFrameTimestamp")(function* (
          inputPath: string,
          frameIndex: number,
          videoStreamIndex: number,
        ) {
          const command = frameProbeCommand(ffprobePath, inputPath, videoStreamIndex);
          const output = yield* runComplete(command);
          return yield* decodeFrameTimestamp(output, frameIndex);
        });
        const classifyAudio = Effect.fn("MediaInspector.classifyAudio")(function* (
          inputPath: string,
          audioStreamIndexes: ReadonlyArray<number>,
          trim?: ResolvedTrimRange,
        ) {
          const outputs = yield* Effect.all(
            audioStreamIndexes.map((streamIndex) =>
              runComplete(buildAudioAnalysisCommand(inputPath, streamIndex, ffmpegPath, trim)),
            ),
            { concurrency: "unbounded" },
          );
          if (trim && outputs.length > 0 && outputs.every((output) => output.trim() === ""))
            return "silent" as const;
          return yield* decodeAudioAnalysis(outputs, threshold);
        });

        return MediaInspector.of({
          checkCapabilities,
          classifyAudio,
          inspect,
          resolveFrameTimestamp,
          resolveTrimRange: (inputPath, range, streamIndex) =>
            resolveTrimRange(ffprobePath, inputPath, range, streamIndex).pipe(
              Effect.provideService(MediaProcessRunner, runner),
            ),
        });
      }),
    );
}

type RunComplete = (
  command: MediaProcessCommand,
) => Effect.Effect<string, MediaInspectionError | MediaProcessError>;

const makeCapabilityCheck = (runComplete: RunComplete, ffmpegPath: string, ffprobePath: string) =>
  Effect.fn("MediaInspector.checkCapabilities")(function* () {
    const [ffmpeg, ffprobe, encoders] = yield* Effect.all(
      [
        runComplete(versionCommand(ffmpegPath)),
        runComplete(versionCommand(ffprobePath)),
        runComplete(encoderCommand(ffmpegPath)),
      ],
      { concurrency: "unbounded" },
    );
    return yield* decodeMediaCapabilities(ffmpeg, ffprobe, encoders);
  });

const versionCommand = (executable: string): MediaProcessCommand => ({
  executable,
  arguments: ["-hide_banner", "-version"],
});

const encoderCommand = (executable: string): MediaProcessCommand => ({
  executable,
  arguments: ["-hide_banner", "-encoders"],
});

const mediaProbeCommand = (executable: string, inputPath: string): MediaProcessCommand => ({
  executable,
  arguments: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath],
});

const frameProbeCommand = (
  executable: string,
  inputPath: string,
  videoStreamIndex: number,
): MediaProcessCommand => ({
  executable,
  arguments: [
    "-v",
    "error",
    "-select_streams",
    String(videoStreamIndex),
    "-show_frames",
    "-show_entries",
    "frame=best_effort_timestamp_time,pts_time",
    "-print_format",
    "json",
    inputPath,
  ],
});
