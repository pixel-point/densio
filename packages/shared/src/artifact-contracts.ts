import { Schema } from "effect";

import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { MediaCodecSchema } from "./media-options.ts";

export const ArtifactKindSchema = Schema.Literals([
  "video",
  "preview-video",
  "preview-image",
  "image-archive",
  "manifest",
]);
export type ArtifactKind = typeof ArtifactKindSchema.Type;

export const ArtifactMetadataSchema = Schema.Struct({
  id: IdentifierSchema,
  kind: ArtifactKindSchema,
  filename: Schema.String.check(Schema.isPattern(/^[^/\\]+$/)),
  mediaType: Schema.String.check(Schema.isPattern(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i)),
  bytes: NonNegativeIntegerSchema,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  downloadUrl: HttpUrlSchema,
  expiresAt: IsoTimestampSchema,
  codec: Schema.optionalKey(MediaCodecSchema),
  width: Schema.optionalKey(PositiveIntegerSchema),
  height: Schema.optionalKey(PositiveIntegerSchema),
  durationSeconds: Schema.optionalKey(PositiveFiniteSchema),
});
export type ArtifactMetadata = typeof ArtifactMetadataSchema.Type;

export const MediaCommandSchema = Schema.Struct({
  executable: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  displayCommand: Schema.NonEmptyString,
  startedAt: IsoTimestampSchema,
  completedAt: Schema.optionalKey(IsoTimestampSchema),
  exitCode: Schema.optionalKey(Schema.Union([NonNegativeIntegerSchema, Schema.Null])),
  stderrTail: Schema.optionalKey(Schema.NonEmptyString),
});
export type MediaCommand = typeof MediaCommandSchema.Type;
