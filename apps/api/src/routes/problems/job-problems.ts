import { makeProblem } from "../../errors/problem-details.ts";
import {
  JobIdempotencyConflict,
  JobNotFound,
  JobStateConflict,
  JobUploadExpired,
  JobUploadLimitExceeded,
} from "../../jobs/job-service.ts";
import { UploadLimitExceeded, UploadSizeMismatch } from "../../storage/upload.ts";

export const jobProblem = (error: unknown) => {
  if (error instanceof JobNotFound) return jobNotFoundProblem();
  if (error instanceof JobIdempotencyConflict) return idempotencyConflictProblem();
  if (error instanceof JobStateConflict) return jobStateProblem(error.state);
  if (error instanceof JobUploadExpired) return uploadExpiredProblem();
  if (error instanceof JobUploadLimitExceeded || error instanceof UploadLimitExceeded) {
    return uploadLimitProblem(error.limitBytes);
  }
  if (error instanceof UploadSizeMismatch) return uploadSizeProblem();
  return undefined;
};

const jobNotFoundProblem = () =>
  makeProblem({
    code: "JOB_NOT_FOUND",
    detail: "The requested job does not exist.",
    retryable: false,
    status: 404,
    suggestedAction: "Check the job ID belongs to the authenticated account.",
    title: "Job not found",
  });

const idempotencyConflictProblem = () =>
  makeProblem({
    code: "IDEMPOTENCY_CONFLICT",
    detail: "The idempotency key was already used for a different request.",
    retryable: false,
    status: 409,
    suggestedAction: "Retry with the original request or use a new idempotency key.",
    title: "Idempotency conflict",
  });

const jobStateProblem = (state: string) =>
  makeProblem({
    code: "JOB_STATE_CONFLICT",
    detail: `The job cannot perform this operation while it is ${state}.`,
    retryable: false,
    status: 409,
    suggestedAction: "Read the current job status before choosing the next action.",
    title: "Job state conflict",
  });

const uploadExpiredProblem = () =>
  makeProblem({
    code: "JOB_UPLOAD_EXPIRED",
    detail: "The upload window for this job has expired.",
    retryable: false,
    status: 410,
    suggestedAction: "Create a new job and upload its source before the expiry time.",
    title: "Upload expired",
  });

const uploadLimitProblem = (limitBytes: number) =>
  makeProblem({
    code: "UPLOAD_TOO_LARGE",
    detail: `The source exceeds the ${limitBytes}-byte upload limit.`,
    retryable: false,
    status: 413,
    suggestedAction: "Upload a smaller source file.",
    title: "Upload too large",
  });

const uploadSizeProblem = () =>
  makeProblem({
    code: "UPLOAD_SIZE_MISMATCH",
    detail: "The uploaded byte count does not match the declared source size.",
    retryable: false,
    status: 400,
    suggestedAction: "Create a new job with the exact source byte count and retry the upload.",
    title: "Upload size mismatch",
  });
