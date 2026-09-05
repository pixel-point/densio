import {
  HlsOptionsSchema,
  MEDIA_CODEC_POLICY,
  ResolvedHlsOptionsSchema,
  type HlsOptions,
  type SourceInspection,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import {
  ExecutionPlanInvalidOptions,
  HlsSourceUnsupported,
} from "../execution-plans/execution-plan-errors.ts";
import { buildFrameRateFilter } from "./frame-rate.ts";

export const resolveHlsOptions = Effect.fn("HlsPolicy.resolve")(function* (
  source: SourceInspection,
  input: HlsOptions,
) {
  const options = yield* Schema.decodeUnknownEffect(HlsOptionsSchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.mapError(
      () => new ExecutionPlanInvalidOptions({ message: "The HLS options are invalid." }),
    ),
  );
  yield* validateHlsSource(source);
  if (options.audio === "keep" && source.audioStreams.length === 0)
    return yield* new ExecutionPlanInvalidOptions({
      message: "Keeping audio requires a source audio stream.",
    });
  if (
    options.ladder?.mode === "custom" &&
    options.ladder.renditions.some(({ height }) => height > source.displayDimensions.height)
  )
    return yield* new ExecutionPlanInvalidOptions({
      message: "HLS renditions cannot request upscaling.",
    });
  const frameRate = options.frameRate ?? { mode: "preserve" as const };
  const filter = buildFrameRateFilter(source.frameRate, frameRate);
  const [numerator, denominator] =
    filter === undefined
      ? [source.frameRate.numerator, source.frameRate.denominator]
      : filter.slice(4).split("/").map(Number);
  const outputFrameRate = {
    numerator: numerator ?? 30,
    denominator: denominator ?? 1,
    framesPerSecond: (numerator ?? 30) / (denominator ?? 1),
  };
  const keyframeIntervalFrames = Math.max(1, Math.round(outputFrameRate.framesPerSecond * 2));
  const requested =
    options.ladder?.mode === "custom" ? options.ladder.renditions : automaticLadder(source);
  const mode = options.rateControl?.mode ?? "capped-crf";
  const renditions = yield* resolveRenditions(
    source,
    options,
    outputFrameRate.framesPerSecond,
    requested,
    mode,
  );
  const segmentDurationSeconds = (keyframeIntervalFrames * 3) / outputFrameRate.framesPerSecond;
  if (
    Math.ceil(source.durationSeconds / segmentDurationSeconds) * (renditions.length + 1) + 20 >
    20000
  )
    return yield* new HlsSourceUnsupported({
      reason: "The source would exceed the 20,000-member package limit.",
    });
  return yield* Schema.decodeUnknownEffect(ResolvedHlsOptionsSchema)({
    profileVersion: "hevc-vod-1",
    codecs: ["h265"],
    preset: "veryslow",
    pixelFormat: "yuv420p10le",
    timestampPolicy: "cfr",
    outputFrameRate,
    frameRate,
    keyframeIntervalFrames,
    segmentDurationSeconds,
    rateControl: { mode },
    renditions,
    audio: options.audio ?? "auto",
    videoStreamIndex: source.primaryVideoStream.index,
    ...(source.audioStreams[0] === undefined
      ? {}
      : { audioStreamIndex: source.audioStreams[0].index }),
    audioBitrateBps: 128000,
    audioSampleRate: 48000,
    audioChannels: 2,
  }).pipe(
    Effect.mapError(
      () =>
        new ExecutionPlanInvalidOptions({
          message: "The HLS profile could not be resolved for this source.",
        }),
    ),
  );
});

export const validateHlsSource = Effect.fn("HlsPolicy.validateSource")(function* (
  source: SourceInspection,
) {
  const properties = source.videoProperties;
  if (properties === undefined)
    return yield* new HlsSourceUnsupported({
      reason:
        "Upload this source again to inspect its color, pixel format, and interlacing metadata.",
    });
  if (
    ["smpte2084", "arib-std-b67"].includes(properties.colorTransfer ?? "") ||
    properties.colorPrimaries === "bt2020"
  )
    return yield* new HlsSourceUnsupported({
      reason:
        "HDR and BT.2020 inputs require a color transform that this HLS profile does not support.",
    });
  if (!["progressive", "unknown"].includes(properties.fieldOrder))
    return yield* new HlsSourceUnsupported({
      reason: "Interlaced input requires deinterlacing before this HLS profile.",
    });
  if (source.frameRate.framesPerSecond < 1 || source.frameRate.framesPerSecond > 120)
    return yield* new HlsSourceUnsupported({
      reason: "HLS supports source rates from 1 to 120 frames per second.",
    });
});

const automaticLadder = (
  source: SourceInspection,
): ReadonlyArray<{
  height: number;
  crf?: { h265?: number };
  maxVideoBitrateBps?: number;
  videoBufferSizeBits?: number;
}> => {
  const { width, height } = source.displayDimensions;
  const shortEdge = Math.min(width, height);
  const tiers = [360, 720, 1080].filter((tier) => tier <= shortEdge);
  const edges = [...new Set([...tiers, ...(shortEdge < 1080 ? [shortEdge] : [])])];
  return edges
    .slice(-3)
    .map((edge) => ({ height: Math.floor((height * edge) / shortEdge / 2) * 2 }));
};

const resolveRenditions = Effect.fn("HlsPolicy.renditions")(function* (
  source: SourceInspection,
  options: HlsOptions,
  framesPerSecond: number,
  requested: ReturnType<typeof automaticLadder>,
  mode: "crf" | "capped-crf",
) {
  const renditions = requested
    .map((rendition) => {
      const height = Math.floor(rendition.height / 2) * 2;
      const width =
        Math.floor(
          (source.displayDimensions.width * height) / source.displayDimensions.height / 2,
        ) * 2;
      const maxVideoBitrateBps =
        rendition.maxVideoBitrateBps ??
        Math.max(150000, Math.ceil((width * height * 3 * framesPerSecond) / 30));
      return {
        width,
        height,
        crf: {
          h265: rendition.crf?.h265 ?? options.crf?.h265 ?? MEDIA_CODEC_POLICY.h265.defaultCrf,
        },
        ...(mode === "crf"
          ? {}
          : {
              maxVideoBitrateBps,
              videoBufferSizeBits: rendition.videoBufferSizeBits ?? maxVideoBitrateBps * 2,
            }),
      };
    })
    .toSorted((left, right) => left.height - right.height)
    .map((rendition, index) => ({ ...rendition, id: `v${index}` }));
  if (
    renditions.some(
      ({ width, height }) =>
        width < 2 ||
        height < 2 ||
        width > source.displayDimensions.width ||
        height > source.displayDimensions.height ||
        width > 8192,
    ) ||
    new Set(renditions.map(({ width, height }) => `${width}:${height}`)).size !== renditions.length
  ) {
    return yield* new ExecutionPlanInvalidOptions({
      message: "HLS renditions must resolve to unique even dimensions without upscaling.",
    });
  }
  return renditions;
});
