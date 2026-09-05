import {
  ResolvedCompressionOptionsSchema,
  ResolvedTrimOptionsSchema,
  type ResolvedCompressionOptions,
} from "@densio/shared";
import { Effect } from "effect";
import { decodeJobOptions } from "./media-job-handler-support.ts";
import type { Job } from "./job-worker.ts";

export const decodeVideoJobOptions = Effect.fn("VideoJob.decodeOptions")(function* (
  job: Job,
): Effect.fn.Return<ResolvedCompressionOptions, unknown> {
  if (job.kind !== "trim")
    return yield* decodeJobOptions(
      ResolvedCompressionOptionsSchema,
      job.resolvedOptionsJson,
      "compression",
    );
  const options = yield* decodeJobOptions(
    ResolvedTrimOptionsSchema,
    job.resolvedOptionsJson,
    "trim",
  );
  return {
    trim: options.trim,
    codecs: [options.output.codec],
    crf: { [options.output.codec]: options.output.crf },
    audio: options.audio,
    frameRate: { mode: "preserve" },
  };
});
