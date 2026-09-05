import { Schema } from "effect";
import { IdentifierSchema } from "./common-contracts.ts";

export const StorageVisibilitySchema = Schema.Literals(["public", "private"]);
export type StorageVisibility = typeof StorageVisibilitySchema.Type;
export const StoredDestinationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("managed") }),
  Schema.Struct({ kind: Schema.Literal("connection"), connectionId: IdentifierSchema }),
]);
export type StoredDestination = typeof StoredDestinationSchema.Type;
export const StorageDestinationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("temporary") }),
  StoredDestinationSchema,
]);
export type StorageDestination = typeof StorageDestinationSchema.Type;
export const VideoNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(255));
export const FilenameStemSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(80),
);
export const StorageSelectionSchema = Schema.Struct({
  destination: StorageDestinationSchema,
  visibility: Schema.optionalKey(StorageVisibilitySchema),
  name: Schema.optionalKey(VideoNameSchema),
});
export type StorageSelection = typeof StorageSelectionSchema.Type;
