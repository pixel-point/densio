import { Schema } from "effect";
import {
  IdentifierSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common-contracts.ts";
import { AudioModeSchema, FrameRatePolicySchema, H265CrfSchema } from "./media-options.ts";
import { SourceFrameRateSchema } from "./source-contracts.ts";

const HlsCrfSchema = Schema.Struct({ h265: Schema.optionalKey(H265CrfSchema) });
const HlsCodecsSchema = Schema.Array(Schema.Literal("h265")).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1),
);
const HlsRenditionRequestSchema = Schema.Struct({
  height: PositiveIntegerSchema.check(Schema.isBetween({ minimum: 2, maximum: 8192 })),
  crf: Schema.optionalKey(HlsCrfSchema),
  maxVideoBitrateBps: Schema.optionalKey(PositiveIntegerSchema),
  videoBufferSizeBits: Schema.optionalKey(PositiveIntegerSchema),
});
export const HlsOptionsSchema = Schema.Struct({
  codecs: Schema.optionalKey(HlsCodecsSchema),
  crf: Schema.optionalKey(HlsCrfSchema),
  ladder: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ mode: Schema.Literal("auto") }),
      Schema.Struct({
        mode: Schema.Literal("custom"),
        renditions: Schema.Array(HlsRenditionRequestSchema).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(3),
        ),
      }),
    ]),
  ),
  rateControl: Schema.optionalKey(Schema.Struct({ mode: Schema.Literals(["crf", "capped-crf"]) })),
  audio: Schema.optionalKey(AudioModeSchema),
  frameRate: Schema.optionalKey(FrameRatePolicySchema),
}).check(
  Schema.makeFilter(({ ladder, rateControl }) => {
    if (
      rateControl?.mode === "crf" &&
      ladder?.mode === "custom" &&
      ladder.renditions.some(
        (rendition) =>
          rendition.maxVideoBitrateBps !== undefined || rendition.videoBufferSizeBits !== undefined,
      )
    )
      return "Uncapped CRF does not accept bitrate or buffer ceilings";
  }),
);
export type HlsOptions = typeof HlsOptionsSchema.Type;

export const HlsRenditionSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^v[0-2]$/)),
  width: PositiveIntegerSchema,
  height: PositiveIntegerSchema,
  crf: Schema.Struct({ h265: H265CrfSchema }),
  maxVideoBitrateBps: Schema.optionalKey(PositiveIntegerSchema),
  videoBufferSizeBits: Schema.optionalKey(PositiveIntegerSchema),
});
export type HlsRendition = typeof HlsRenditionSchema.Type;

export const ResolvedHlsOptionsSchema = Schema.Struct({
  profileVersion: Schema.Literal("hevc-vod-1"),
  codecs: HlsCodecsSchema,
  preset: Schema.Literal("veryslow"),
  audio: AudioModeSchema,
  frameRate: FrameRatePolicySchema,
  outputFrameRate: SourceFrameRateSchema,
  timestampPolicy: Schema.Literal("cfr"),
  segmentDurationSeconds: PositiveFiniteSchema,
  keyframeIntervalFrames: PositiveIntegerSchema,
  pixelFormat: Schema.Literal("yuv420p10le"),
  rateControl: Schema.Struct({ mode: Schema.Literals(["crf", "capped-crf"]) }),
  videoStreamIndex: NonNegativeIntegerSchema,
  audioStreamIndex: Schema.optionalKey(NonNegativeIntegerSchema),
  audioBitrateBps: Schema.Literal(128000),
  audioSampleRate: Schema.Literal(48000),
  audioChannels: Schema.Literal(2),
  renditions: Schema.Array(HlsRenditionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
}).check(
  Schema.makeFilter(({ rateControl, renditions }) => {
    if (new Set(renditions.map(({ id }) => id)).size !== renditions.length)
      return "Rendition IDs must be unique";
    if (renditions.some(({ width, height }) => width % 2 !== 0 || height % 2 !== 0))
      return "HLS dimensions must be even";
    if (
      rateControl.mode === "capped-crf" &&
      renditions.some(
        (rendition) =>
          rendition.maxVideoBitrateBps === undefined || rendition.videoBufferSizeBits === undefined,
      )
    )
      return "Capped CRF requires resolved bitrate and buffer ceilings";
    if (
      rateControl.mode === "crf" &&
      renditions.some(
        (rendition) =>
          rendition.maxVideoBitrateBps !== undefined || rendition.videoBufferSizeBits !== undefined,
      )
    )
      return "Uncapped CRF cannot have bitrate ceilings";
  }),
);
export type ResolvedHlsOptions = typeof ResolvedHlsOptionsSchema.Type;

export const HlsMemberPathSchema = Schema.String.check(
  Schema.isPattern(
    /^(?:master\.m3u8|(?:v[0-2]|audio)\/(?:index\.m3u8|init_(?:v[0-2]|audio)\.mp4|segment-\d{6}\.m4s))$/,
  ),
);
export const HlsMemberSchema = Schema.Struct({
  path: HlsMemberPathSchema,
  role: Schema.Literals(["master", "playlist", "initialization", "segment"]),
  mediaType: Schema.Literals(["application/vnd.apple.mpegurl", "video/mp4", "audio/mp4"]),
  bytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
});
export type HlsMember = typeof HlsMemberSchema.Type;

export const HlsPackageRenditionSchema = Schema.Struct({
  ...HlsRenditionSchema.fields,
  playlist: HlsMemberPathSchema,
  codecs: Schema.NonEmptyString,
  bandwidth: PositiveIntegerSchema,
  averageBandwidth: PositiveIntegerSchema,
  segmentCount: PositiveIntegerSchema,
  durationSeconds: PositiveFiniteSchema,
});
export const HlsPackageSchema = Schema.Struct({
  packageId: IdentifierSchema,
  masterPlaylist: Schema.Literal("master.m3u8"),
  packageBytes: PositiveIntegerSchema,
  frameRate: SourceFrameRateSchema,
  audio: Schema.Boolean,
  renditions: Schema.Array(HlsPackageRenditionSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(3),
  ),
  members: Schema.Array(HlsMemberSchema).check(Schema.isMinLength(1), Schema.isMaxLength(20000)),
}).check(
  Schema.makeFilter(({ members, packageBytes }) => {
    if (new Set(members.map(({ path }) => path)).size !== members.length)
      return "HLS member paths must be unique";
    if (members.reduce((sum, member) => sum + member.bytes, 0) !== packageBytes)
      return "Package bytes must match the member inventory";
  }),
);
export type HlsPackage = typeof HlsPackageSchema.Type;

export const HlsResultSchema = Schema.Struct({
  kind: Schema.Literal("hls"),
  archiveArtifactId: IdentifierSchema,
  packageId: IdentifierSchema,
  masterPlaylist: Schema.Literal("master.m3u8"),
  packageBytes: PositiveIntegerSchema,
  archiveBytes: PositiveIntegerSchema,
  renditions: Schema.Array(HlsPackageRenditionSchema).check(Schema.isMinLength(1)),
});
export type HlsResult = typeof HlsResultSchema.Type;
