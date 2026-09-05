import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import {
  SourceIdempotencyConflict,
  SourceNotFound,
  SourceStateConflict,
  SourceUploadExpired,
  SourceUploadLimitExceeded,
} from "../../sources/prepared-source-service.ts";
import { UploadLimitExceeded, UploadSizeMismatch } from "../../storage/upload.ts";

export const sourceNotFoundProblemDescriptor = defineProblem({
  code: "SOURCE_NOT_FOUND",
  description: "The prepared source does not exist for this user.",
  status: 404,
  title: "Source not found",
});

export const sourceIdempotencyProblemDescriptor = defineProblem({
  code: "SOURCE_IDEMPOTENCY_CONFLICT",
  description: "The source idempotency key conflicts with another request.",
  status: 409,
  title: "Source idempotency conflict",
});

export const sourceStateProblemDescriptor = defineProblem({
  code: "SOURCE_STATE_CONFLICT",
  description: "The source is not in a state that permits this operation.",
  status: 409,
  title: "Source state conflict",
});

export const sourceUploadExpiredProblemDescriptor = defineProblem({
  code: "SOURCE_UPLOAD_EXPIRED",
  description: "The prepared source upload window has expired.",
  status: 410,
  title: "Source upload expired",
});

export const sourceUploadLimitProblemDescriptor = defineProblem({
  code: "SOURCE_UPLOAD_TOO_LARGE",
  description: "The source exceeds the account or server upload limit.",
  status: 413,
  title: "Source upload too large",
});

export const sourceUploadSizeProblemDescriptor = defineProblem({
  code: "SOURCE_UPLOAD_SIZE_MISMATCH",
  description: "The uploaded byte count differs from the source declaration.",
  status: 400,
  title: "Source upload size mismatch",
});

export const sourceProblem = (error: unknown) => {
  if (error instanceof SourceNotFound) return sourceNotFoundProblem();
  if (error instanceof SourceIdempotencyConflict) return sourceIdempotencyProblem();
  if (error instanceof SourceStateConflict) return sourceStateProblem(error.state);
  if (error instanceof SourceUploadExpired) return sourceUploadExpiredProblem();
  if (error instanceof SourceUploadLimitExceeded || error instanceof UploadLimitExceeded) {
    return sourceUploadLimitProblem(error.limitBytes);
  }
  if (error instanceof UploadSizeMismatch) return sourceUploadSizeProblem();
  return undefined;
};

const sourceNotFoundProblem = () =>
  makeDescriptorProblem(sourceNotFoundProblemDescriptor, {
    detail: "The requested prepared source does not exist.",
    retryable: false,
    suggestedAction: "Check that the source ID belongs to the authenticated account.",
  });

const sourceIdempotencyProblem = () =>
  makeDescriptorProblem(sourceIdempotencyProblemDescriptor, {
    detail: "The idempotency key was already used with a different source declaration.",
    retryable: false,
    suggestedAction: "Retry the original declaration or choose a new idempotency key.",
  });

const sourceStateProblem = (state: string) =>
  makeDescriptorProblem(sourceStateProblemDescriptor, {
    detail: `The prepared source cannot perform this operation while it is ${state}.`,
    retryable: false,
    suggestedAction: "Read the current source status before choosing the next action.",
  });

const sourceUploadExpiredProblem = () =>
  makeDescriptorProblem(sourceUploadExpiredProblemDescriptor, {
    detail: "The upload window for this prepared source has expired.",
    retryable: false,
    suggestedAction: "Create a new prepared source and upload before its action expires.",
  });

const sourceUploadLimitProblem = (limitBytes: number) =>
  makeDescriptorProblem(sourceUploadLimitProblemDescriptor, {
    detail: `The prepared source exceeds the ${limitBytes}-byte upload limit.`,
    retryable: false,
    suggestedAction: "Upload a smaller source or use an account with a larger upload allowance.",
  });

const sourceUploadSizeProblem = () =>
  makeDescriptorProblem(sourceUploadSizeProblemDescriptor, {
    detail: "The uploaded bytes do not match the declared prepared source size.",
    retryable: false,
    suggestedAction: "Delete the source, recreate it with the exact byte count, and retry.",
  });
