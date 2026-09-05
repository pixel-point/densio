import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import { VideoStorageError, type StorageErrorCode } from "../../storage/storage-errors.ts";

const statuses: Record<StorageErrorCode, number> = {
  VIDEO_NOT_FOUND: 404,
  STORAGE_TRANSFER_NOT_FOUND: 404,
  STORAGE_UPGRADE_REQUIRED: 403,
  STORAGE_QUOTA_EXCEEDED: 409,
  STORAGE_CONNECTION_UNAVAILABLE: 409,
  STORAGE_PERMISSION_DENIED: 422,
  STORAGE_ENDPOINT_REJECTED: 422,
  STORAGE_PROVIDER_UNSUPPORTED: 422,
  STORAGE_OBJECT_CHANGED: 409,
  STORAGE_RECOVERY_EXPIRED: 410,
  STORAGE_DELETION_BLOCKED: 503,
  STORAGE_PUBLIC_DELIVERY_REQUIRED: 422,
  STORAGE_PRIVATE_STAGING_REQUIRED: 422,
  STORAGE_VISIBILITY_UNSUPPORTED: 422,
  STORAGE_NOT_CONFIGURED: 503,
  STORAGE_BUSY: 409,
  STORAGE_ACCESS_EXPIRED: 404,
  STORAGE_UPLOAD_LIMIT_EXCEEDED: 429,
  STORAGE_INVALID_STATE: 409,
  STORAGE_PROVIDER_UNAVAILABLE: 503,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_REQUEST: 400,
  STORAGE_INTERNAL_ERROR: 500,
};
export const videoStorageDescriptor = (code: StorageErrorCode) =>
  defineProblem({
    code,
    status: statuses[code],
    title: "Video storage request failed",
    description: code,
  });
export const videoStorageProblem = (error: unknown) =>
  error instanceof VideoStorageError
    ? makeDescriptorProblem(videoStorageDescriptor(error.code), {
        detail: error.detail,
        retryable:
          error.code === "STORAGE_BUSY" ||
          error.code === "STORAGE_PROVIDER_UNAVAILABLE" ||
          error.code === "STORAGE_DELETION_BLOCKED",
        suggestedAction:
          "Inspect storage status, correct the reported destination or capacity issue, and retry the same operation before its recovery deadline.",
      })
    : undefined;
export const videoStorageProblemDescriptors = Object.keys(statuses).map((code) =>
  videoStorageDescriptor(code as StorageErrorCode),
);
