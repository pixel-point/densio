export const MEDIA_CODECS = ["vp9", "h265", "av1"] as const;
export type MediaCodec = (typeof MEDIA_CODECS)[number];
export const DEFAULT_COMPRESSION_CODECS = [
  "vp9",
  "h265",
] as const satisfies ReadonlyArray<MediaCodec>;

export const MEDIA_CODEC_POLICY = Object.freeze({
  vp9: Object.freeze({
    codec: "vp9",
    container: "webm",
    crfRange: Object.freeze({ maximum: 63, minimum: 0 }),
    defaultCrf: 42,
    minimumPlan: "free",
  }),
  h265: Object.freeze({
    codec: "h265",
    container: "mp4",
    crfRange: Object.freeze({ maximum: 51, minimum: 0 }),
    defaultCrf: 30,
    minimumPlan: "free",
  }),
  av1: Object.freeze({
    codec: "av1",
    container: "webm",
    crfRange: Object.freeze({ maximum: 63, minimum: 0 }),
    defaultCrf: 42,
    minimumPlan: "basic",
  }),
} as const);

export const MEDIA_CODEC_CAPABILITIES = Object.freeze(
  MEDIA_CODECS.map((codec) => MEDIA_CODEC_POLICY[codec]),
);
