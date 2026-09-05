import { Schema } from "effect";
import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PlanSchema,
} from "./common-contracts.ts";
import {
  StorageDestinationSchema,
  StorageVisibilitySchema,
  VideoNameSchema,
} from "./storage-options.ts";

export const StorageCredentialsSchema = Schema.Struct({
  accessKeyId: Schema.NonEmptyString,
  secretAccessKey: Schema.NonEmptyString,
});
export type StorageCredentials = typeof StorageCredentialsSchema.Type;
export const StorageLocationSchema = Schema.Struct({
  endpoint: HttpUrlSchema,
  region: Schema.NonEmptyString,
  bucket: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)),
  prefix: Schema.String.check(Schema.isMaxLength(512)),
  pathStyle: Schema.Boolean,
});
export type StorageLocation = typeof StorageLocationSchema.Type;
export const StorageConnectionConfigSchema = Schema.Struct({
  provider: Schema.Literals(["s3", "r2", "generic"]),
  location: StorageLocationSchema,
  visibility: StorageVisibilitySchema,
  publicBaseUrl: Schema.optionalKey(HttpUrlSchema),
  staging: Schema.optionalKey(StorageLocationSchema),
  stagingPublicBaseUrl: Schema.optionalKey(HttpUrlSchema),
});
export type StorageConnectionConfig = typeof StorageConnectionConfigSchema.Type;
export const StorageConnectionCreateRequestSchema = Schema.Struct({
  name: VideoNameSchema,
  config: StorageConnectionConfigSchema,
  credentials: StorageCredentialsSchema,
  stagingCredentials: Schema.optionalKey(StorageCredentialsSchema),
});
export type StorageConnectionCreateRequest = typeof StorageConnectionCreateRequestSchema.Type;
export const StorageConnectionSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  connectionId: IdentifierSchema,
  name: VideoNameSchema,
  config: StorageConnectionConfigSchema,
  state: Schema.Literals(["pending-validation", "active", "error", "disabled", "disconnected"]),
  credentialVersion: NonNegativeIntegerSchema,
  createdAt: IsoTimestampSchema,
  validatedAt: Schema.optionalKey(IsoTimestampSchema),
  errorCode: Schema.optionalKey(Schema.NonEmptyString),
});
export type StorageConnection = typeof StorageConnectionSchema.Type;
export const StorageConnectionResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  connection: StorageConnectionSchema,
});
export const StorageConnectionListResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  connections: Schema.Array(StorageConnectionSchema),
});
export const StorageConnectionCreateResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  replayed: Schema.Boolean,
  connection: StorageConnectionSchema,
});
export const StorageConnectionUpdateRequestSchema = Schema.Struct({ name: VideoNameSchema });
export const StorageCredentialRotationRequestSchema = Schema.Struct({
  credentials: StorageCredentialsSchema,
  stagingCredentials: Schema.optionalKey(StorageCredentialsSchema),
});
export const StorageConnectionOperationSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  operationId: IdentifierSchema,
  connectionId: IdentifierSchema,
  kind: Schema.Literals(["validate", "rotate", "disable", "disconnect"]),
  state: Schema.Literals(["pending", "running", "succeeded", "blocked"]),
  errorCode: Schema.optionalKey(Schema.String),
  cleanupRequired: Schema.Array(
    Schema.Struct({
      bucket: Schema.String,
      key: Schema.String,
      uploadId: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const StorageConnectionOperationResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  operation: StorageConnectionOperationSchema,
});
export const StorageSettingsSchema = Schema.Struct({
  destination: StorageDestinationSchema,
  visibility: StorageVisibilitySchema,
});
export const StorageSettingsResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  settings: StorageSettingsSchema,
});
export const StorageUsageSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  plan: PlanSchema,
  includedStorageBytes: NonNegativeIntegerSchema,
  usedBytes: NonNegativeIntegerSchema,
  reservedBytes: NonNegativeIntegerSchema,
  transientBytes: NonNegativeIntegerSchema,
  cleanupPendingBytes: NonNegativeIntegerSchema,
  availableBytes: NonNegativeIntegerSchema,
  graceDeadline: Schema.optionalKey(IsoTimestampSchema),
  purgeVideoIds: Schema.Array(IdentifierSchema),
});
export type StorageUsage = typeof StorageUsageSchema.Type;
export const StorageUsageResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  usage: StorageUsageSchema,
});

export const StorageConnectionRotateRequestSchema = Schema.Struct({
  credentials: StorageCredentialsSchema,
  stagingCredentials: Schema.optionalKey(StorageCredentialsSchema),
});
