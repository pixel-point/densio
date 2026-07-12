import { Effect, Schema } from "effect";

import { MediaInspectionError } from "./media-inspection-error.ts";

const ProbeSideDataSchema = Schema.Struct({
  rotation: Schema.optionalKey(Schema.Finite),
});

const ProbeStreamSchema = Schema.Struct({
  index: Schema.Int,
  codec_name: Schema.optionalKey(Schema.String),
  codec_type: Schema.String,
  width: Schema.optionalKey(Schema.Int),
  height: Schema.optionalKey(Schema.Int),
  duration: Schema.optionalKey(Schema.String),
  avg_frame_rate: Schema.optionalKey(Schema.String),
  r_frame_rate: Schema.optionalKey(Schema.String),
  disposition: Schema.optionalKey(Schema.Struct({ attached_pic: Schema.optionalKey(Schema.Int) })),
  tags: Schema.optionalKey(Schema.Struct({ rotate: Schema.optionalKey(Schema.String) })),
  side_data_list: Schema.optionalKey(Schema.Array(ProbeSideDataSchema)),
});

const ProbeOutputSchema = Schema.Struct({
  format: Schema.Struct({ duration: Schema.optionalKey(Schema.String) }),
  streams: Schema.Array(ProbeStreamSchema),
});

const decodeProbeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ProbeOutputSchema));
type ProbeOutput = typeof ProbeOutputSchema.Type;
type ProbeStream = typeof ProbeStreamSchema.Type;

export interface MediaStream {
  readonly codecName?: string;
  readonly index: number;
  readonly type: string;
}

export interface MediaProbe {
  readonly audioStreamIndexes: ReadonlyArray<number>;
  readonly displayDimensions: { readonly height: number; readonly width: number };
  readonly durationSeconds: number;
  readonly encodedDimensions: { readonly height: number; readonly width: number };
  readonly frameRate: {
    readonly denominator: number;
    readonly framesPerSecond: number;
    readonly numerator: number;
  };
  readonly rotationDegrees: number;
  readonly streams: ReadonlyArray<MediaStream>;
  readonly videoStreamIndex: number;
}

export const decodeMediaProbe = Effect.fn("decodeMediaProbe")(function* (output: string) {
  const probe = yield* decodeProbeOutput(output).pipe(
    Effect.mapError(
      () =>
        new MediaInspectionError({
          message: "FFprobe returned malformed JSON metadata.",
          reason: "invalid-probe-output",
        }),
    ),
  );
  const video = primaryVideoStream(probe);
  if (video === undefined) {
    return yield* new MediaInspectionError({
      message: "The submitted media does not contain a playable video stream.",
      reason: "no-video-stream",
    });
  }

  return yield* buildMediaProbe(probe, video);
});

const buildMediaProbe = Effect.fn("buildMediaProbe")(function* (
  probe: ProbeOutput,
  video: ProbeStream,
) {
  const durationSeconds = positiveNumber(probe.format.duration ?? video.duration);
  const width = positiveInteger(video.width);
  const height = positiveInteger(video.height);
  const frameRate = rational(video.avg_frame_rate) ?? rational(video.r_frame_rate);
  if (durationSeconds === undefined || width === undefined || height === undefined || !frameRate) {
    return yield* invalidVideoMetadata();
  }

  const rotationDegrees = rotation(video);
  const rotated = rotationDegrees === 90 || rotationDegrees === 270;
  return {
    audioStreamIndexes: probe.streams
      .filter(({ codec_type }) => codec_type === "audio")
      .map(({ index }) => index),
    displayDimensions: rotated ? { height: width, width: height } : { height, width },
    durationSeconds,
    encodedDimensions: { height, width },
    frameRate: {
      denominator: frameRate.denominator,
      framesPerSecond: frameRate.numerator / frameRate.denominator,
      numerator: frameRate.numerator,
    },
    rotationDegrees,
    streams: probe.streams.map(({ codec_name, codec_type, index }) => ({
      ...(codec_name === undefined ? {} : { codecName: codec_name }),
      index,
      type: codec_type,
    })),
    videoStreamIndex: video.index,
  };
});

const primaryVideoStream = (probe: ProbeOutput) =>
  probe.streams.find(
    ({ codec_type, disposition }) =>
      codec_type === "video" && (disposition?.attached_pic ?? 0) !== 1,
  );

const positiveNumber = (value?: string) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const positiveInteger = (value?: number) =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const rational = (value?: string) => {
  if (value === undefined) return undefined;
  const [numeratorText, denominatorText, extra] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (
    extra !== undefined ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return undefined;
  }

  return { denominator, numerator };
};

const rotation = (stream: ProbeStream) => {
  const sideDataRotation = stream.side_data_list?.find(
    ({ rotation: degrees }) => degrees !== undefined,
  )?.rotation;
  const degrees = sideDataRotation ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(degrees)) return 0;

  return ((Math.round(degrees) % 360) + 360) % 360;
};

const invalidVideoMetadata = () =>
  new MediaInspectionError({
    message: "The video stream has incomplete or invalid metadata.",
    reason: "invalid-video-metadata",
  });
