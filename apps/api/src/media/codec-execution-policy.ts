import type { MediaCodec } from "@densio/shared";

interface CodecExecutionPolicy {
  readonly audioEncoder: "aac" | "libopus";
  readonly encoder: "libsvtav1" | "libvpx-vp9" | "libx265";
  readonly fileExtension: "mp4" | "webm";
  readonly mediaType: "video/mp4" | "video/webm";
}

export const MEDIA_CODEC_EXECUTION_POLICY = Object.freeze({
  vp9: Object.freeze({
    audioEncoder: "libopus",
    encoder: "libvpx-vp9",
    fileExtension: "webm",
    mediaType: "video/webm",
  }),
  h265: Object.freeze({
    audioEncoder: "aac",
    encoder: "libx265",
    fileExtension: "mp4",
    mediaType: "video/mp4",
  }),
  av1: Object.freeze({
    audioEncoder: "libopus",
    encoder: "libsvtav1",
    fileExtension: "webm",
    mediaType: "video/webm",
  }),
} as const satisfies Record<MediaCodec, CodecExecutionPolicy>);
