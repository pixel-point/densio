import { Schema } from "effect";

import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  SafePathComponentSchema,
  Sha256Schema,
} from "./common-contracts.ts";
import { MediaCodecSchema } from "./media-options.ts";

export const ArtifactKindSchema = Schema.Literals([
  "video",
  "preview-video",
  "preview-image",
  "image-archive",
  "hls-archive",
  "manifest",
]);
export type ArtifactKind = typeof ArtifactKindSchema.Type;

const ArtifactMediaTypeSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
);

const ArtifactFactsFields = {
  organizationId: IdentifierSchema,
  id: IdentifierSchema,
  kind: ArtifactKindSchema,
  filename: SafePathComponentSchema,
  mediaType: ArtifactMediaTypeSchema,
  bytes: NonNegativeIntegerSchema,
  sha256: Sha256Schema,
  codec: Schema.optionalKey(MediaCodecSchema),
  width: Schema.optionalKey(PositiveIntegerSchema),
  height: Schema.optionalKey(PositiveIntegerSchema),
  durationSeconds: Schema.optionalKey(PositiveFiniteSchema),
};

export const ArtifactAvailabilitySchema = Schema.Literals(["available", "deleted", "expired"]);
export type ArtifactAvailability = typeof ArtifactAvailabilitySchema.Type;

export const ArtifactReceiptSchema = Schema.Struct({
  ...ArtifactFactsFields,
  retainedUntil: IsoTimestampSchema,
});
export type ArtifactReceipt = typeof ArtifactReceiptSchema.Type;

export const ArtifactDescriptorSchema = Schema.Struct({
  ...ArtifactFactsFields,
  availability: ArtifactAvailabilitySchema,
  retainedUntil: IsoTimestampSchema,
  authorizeUrl: HttpUrlSchema,
  deleteUrl: HttpUrlSchema,
});
export type ArtifactDescriptor = typeof ArtifactDescriptorSchema.Type;

export const ArtifactDownloadActionSchema = Schema.Struct({
  method: Schema.Literal("GET"),
  url: HttpUrlSchema,
  expiresAt: IsoTimestampSchema,
});
export type ArtifactDownloadAction = typeof ArtifactDownloadActionSchema.Type;

export const ArtifactAuthorizationSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  artifact: ArtifactDescriptorSchema,
  download: ArtifactDownloadActionSchema,
});
export type ArtifactAuthorization = typeof ArtifactAuthorizationSchema.Type;

export const ArtifactDeletedResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  artifactId: IdentifierSchema,
  deleted: Schema.Literal(true),
  deletedAt: IsoTimestampSchema,
});
export type ArtifactDeletedResponse = typeof ArtifactDeletedResponseSchema.Type;

export const MaterializedArtifactFileSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  artifactId: IdentifierSchema,
  filename: SafePathComponentSchema,
  path: Schema.NonEmptyString,
  bytes: NonNegativeIntegerSchema,
  sha256: Sha256Schema,
  verified: Schema.Literal(true),
});
export type MaterializedArtifactFile = typeof MaterializedArtifactFileSchema.Type;

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
