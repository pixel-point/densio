import { HlsPackageSchema, HlsPackageRenditionSchema } from "./hls-contracts.ts";
import { Schema } from "effect";
import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  SafePathComponentSchema,
  Sha256Schema,
} from "./common-contracts.ts";
import { MediaCodecSchema } from "./media-options.ts";
import {
  FilenameStemSchema,
  StoredDestinationSchema,
  StorageVisibilitySchema,
  VideoNameSchema,
} from "./storage-options.ts";

export const VideoStateSchema = Schema.Literals([
  "storing",
  "ready",
  "storage-blocked",
  "storage-failed",
  "unavailable",
  "visibility-changing",
  "deleting",
  "deleted",
]);
export const StorageTransferStateSchema = Schema.Literals([
  "pending",
  "uploading",
  "verifying",
  "retry-wait",
  "blocked",
  "succeeded",
  "failed",
  "canceled",
]);
export const VideoVariantSchema = Schema.Struct({
  variantId: IdentifierSchema,
  filename: SafePathComponentSchema,
  codec: MediaCodecSchema,
  mediaType: Schema.Literals(["video/webm", "video/mp4"]),
  bytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
  width: Schema.optionalKey(PositiveIntegerSchema),
  height: Schema.optionalKey(PositiveIntegerSchema),
  durationSeconds: Schema.optionalKey(Schema.Finite),
  publicUrl: Schema.optionalKey(HttpUrlSchema),
});
export type VideoVariant = typeof VideoVariantSchema.Type;
export const VideoSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  videoId: IdentifierSchema,
  jobId: IdentifierSchema,
  displayName: VideoNameSchema,
  filenameStem: FilenameStemSchema,
  destination: StoredDestinationSchema,
  visibility: StorageVisibilitySchema,
  visibilityRevision: NonNegativeIntegerSchema,
  state: VideoStateSchema,
  variants: Schema.Array(VideoVariantSchema),
  hls: Schema.optionalKey(
    Schema.Struct({
      packageId: IdentifierSchema,
      masterPlaylist: Schema.Literal("master.m3u8"),
      packageBytes: PositiveIntegerSchema,
      renditions: Schema.Array(HlsPackageRenditionSchema).check(Schema.isMinLength(1)),
      playbackUrl: Schema.optionalKey(HttpUrlSchema),
    }),
  ),
  createdAt: IsoTimestampSchema,
  storedAt: Schema.optionalKey(IsoTimestampSchema),
  retentionDeadline: Schema.optionalKey(IsoTimestampSchema),
  transferId: IdentifierSchema,
  embedHtml: Schema.optionalKey(Schema.String),
  errorCode: Schema.optionalKey(Schema.NonEmptyString),
}).check(
  Schema.makeFilter((video) => {
    if (video.hls === undefined && video.variants.length === 0)
      return "Progressive video requires variants";
    if (video.hls !== undefined && video.variants.length !== 0)
      return "HLS renditions are separate from progressive variants";
    if (
      video.hls?.playbackUrl !== undefined &&
      (video.state !== "ready" || video.visibility !== "public")
    )
      return "HLS playback requires ready public delivery";
    if (
      video.hls !== undefined &&
      video.state === "ready" &&
      video.visibility === "public" &&
      video.hls.playbackUrl === undefined
    )
      return "Ready public HLS requires a playback URL";
    if (
      (video.visibility !== "public" || video.state !== "ready") &&
      (video.embedHtml !== undefined ||
        video.variants.some((variant) => variant.publicUrl !== undefined))
    )
      return "Only ready public videos expose embed URLs";
    if (
      video.state === "ready" &&
      video.visibility === "public" &&
      (video.embedHtml === undefined ||
        video.variants.some((variant) => variant.publicUrl === undefined))
    )
      return "Ready public videos require verified delivery URLs";
  }),
);
export type Video = typeof VideoSchema.Type;
export const VideoSaveRequestSchema = Schema.Struct({
  jobId: IdentifierSchema,
  destination: Schema.optionalKey(StoredDestinationSchema),
  visibility: Schema.optionalKey(StorageVisibilitySchema),
  name: Schema.optionalKey(VideoNameSchema),
});
export type VideoSaveRequest = typeof VideoSaveRequestSchema.Type;
export const VideoResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  video: VideoSchema,
});
export const VideoMutationResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  replayed: Schema.Boolean,
  video: VideoSchema,
});
export const VideoListResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  videos: Schema.Array(VideoSchema),
  nextCursor: Schema.optionalKey(Schema.String),
});
export const VideoRenameRequestSchema = Schema.Struct({ name: VideoNameSchema });
export const VideoVisibilityRequestSchema = Schema.Struct({ visibility: StorageVisibilitySchema });
export const VideoDeleteRequestSchema = Schema.Struct({
  deleteObjects: Schema.optionalKey(Schema.Boolean),
});
export const VideoExportRequestSchema = Schema.Struct({
  connectionId: IdentifierSchema,
  visibility: Schema.optionalKey(StorageVisibilitySchema),
});
export const StorageTransferSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  transferId: IdentifierSchema,
  videoId: IdentifierSchema,
  kind: Schema.Literals(["save", "export", "visibility", "delete"]),
  state: StorageTransferStateSchema,
  attempts: NonNegativeIntegerSchema,
  recoveryDeadline: IsoTimestampSchema,
  errorCode: Schema.optionalKey(Schema.String),
  nextAttemptAt: Schema.optionalKey(IsoTimestampSchema),
});
export type StorageTransfer = typeof StorageTransferSchema.Type;
export const StorageTransferResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  transfer: StorageTransferSchema,
});
export const VideoDownloadResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  videoId: IdentifierSchema,
  variantId: IdentifierSchema,
  download: Schema.Struct({
    method: Schema.Literal("GET"),
    url: HttpUrlSchema,
    expiresAt: IsoTimestampSchema,
  }),
});

export const VideoListQuerySchema = Schema.Struct({
  state: Schema.optionalKey(VideoStateSchema),
  limit: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2000))),
});
export type VideoListQuery = typeof VideoListQuerySchema.Type;

export const VideoPackageDownloadResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  videoId: IdentifierSchema,
  package: HlsPackageSchema,
  download: Schema.Struct({
    method: Schema.Literal("GET"),
    baseUrl: HttpUrlSchema,
    expiresAt: IsoTimestampSchema,
  }),
});
