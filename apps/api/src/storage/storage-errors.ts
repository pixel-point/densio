import { Effect, Schema } from "effect";
import { OrganizationError } from "../organizations/organization-errors.ts";

export const StorageErrorCodeSchema = Schema.Literals([
  "VIDEO_NOT_FOUND",
  "STORAGE_TRANSFER_NOT_FOUND",
  "STORAGE_UPGRADE_REQUIRED",
  "STORAGE_QUOTA_EXCEEDED",
  "STORAGE_CONNECTION_UNAVAILABLE",
  "STORAGE_PERMISSION_DENIED",
  "STORAGE_ENDPOINT_REJECTED",
  "STORAGE_PROVIDER_UNSUPPORTED",
  "STORAGE_OBJECT_CHANGED",
  "STORAGE_RECOVERY_EXPIRED",
  "STORAGE_DELETION_BLOCKED",
  "STORAGE_PUBLIC_DELIVERY_REQUIRED",
  "STORAGE_PRIVATE_STAGING_REQUIRED",
  "STORAGE_VISIBILITY_UNSUPPORTED",
  "STORAGE_NOT_CONFIGURED",
  "STORAGE_BUSY",
  "STORAGE_ACCESS_EXPIRED",
  "STORAGE_UPLOAD_LIMIT_EXCEEDED",
  "STORAGE_INVALID_STATE",
  "STORAGE_PROVIDER_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
  "STORAGE_INTERNAL_ERROR",
]);
export type StorageErrorCode = typeof StorageErrorCodeSchema.Type;
export class VideoStorageError extends Schema.TaggedErrorClass<VideoStorageError>()(
  "VideoStorageError",
  {
    code: StorageErrorCodeSchema,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
    operation: Schema.optionalKey(Schema.String),
  },
) {}
export const storageFailure = (
  code: StorageErrorCode,
  detail = "The storage operation could not be completed.",
) => new VideoStorageError({ code, detail });
export const storageEffect = <A>(operationName: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof VideoStorageError || error instanceof OrganizationError
        ? error
        : internalStorageFailure(error, operationName),
  });
export const storagePromise = <A>(
  operationName: string,
  operation: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      error instanceof VideoStorageError || error instanceof OrganizationError
        ? error
        : internalStorageFailure(error, operationName),
  });

const internalStorageFailure = (cause: unknown, operation: string) =>
  new VideoStorageError({
    code: "STORAGE_INTERNAL_ERROR",
    detail: "The storage operation could not be completed.",
    cause,
    operation,
  });
