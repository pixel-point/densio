import { Schema } from "effect";
import {
  HttpUrlSchema,
  NonNegativeIntegerSchema,
  SafePathComponentSchema,
} from "./common-contracts.ts";
import { MediaCodecSchema } from "./media-options.ts";
import {
  FilenameStemSchema,
  StoredDestinationSchema,
  StorageVisibilitySchema,
  VideoNameSchema,
} from "./storage-options.ts";

export const StoredVideoPlanSchema = Schema.Struct({
  destination: StoredDestinationSchema,
  visibility: StorageVisibilitySchema,
  displayName: VideoNameSchema,
  filenameStem: FilenameStemSchema,
  targetId: Schema.NonEmptyString,
  publicOrigin: Schema.optionalKey(HttpUrlSchema),
  keyPrefix: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      codec: MediaCodecSchema,
      filename: SafePathComponentSchema,
      kind: Schema.optionalKey(Schema.Literal("hls-package")),
    }),
  ).check(Schema.isMinLength(1)),
  capacity: Schema.optionalKey(
    Schema.Struct({
      includedStorageBytes: NonNegativeIntegerSchema,
      usedBytes: NonNegativeIntegerSchema,
      reservedBytes: NonNegativeIntegerSchema,
    }),
  ),
});
export type StoredVideoPlan = typeof StoredVideoPlanSchema.Type;
export const ResolvedStoragePlanSchema = Schema.Union([
  Schema.Struct({ destination: Schema.Struct({ kind: Schema.Literal("temporary") }) }),
  StoredVideoPlanSchema,
]);
export type ResolvedStoragePlan = typeof ResolvedStoragePlanSchema.Type;
