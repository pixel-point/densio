import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import {
  JobIdempotencyConflict,
  JobComparisonDurationExceeded,
  JobCreditsExhausted,
  JobNotFound,
  JobStateConflict,
  JobUploadExpired,
  JobUploadLimitExceeded,
} from "../../jobs/job-service.ts";
import { UploadLimitExceeded, UploadSizeMismatch } from "../../storage/upload.ts";

export const comparisonDurationProblemDescriptor = defineProblem({
  code: "INVALID_REQUEST",
  description: "The comparison duration exceeds this server's configured limit.",
  status: 400,
  title: "Invalid request",
});

export const creditsExhaustedProblemDescriptor = defineProblem({
  code: "CREDITS_EXHAUSTED",
  description: "The account has no credits available in its current monthly allowance.",
  status: 402,
  title: "Credits exhausted",
});

export const jobNotFoundProblemDescriptor = defineProblem({
  code: "JOB_NOT_FOUND",
  description: "The job does not exist for this user.",
  status: 404,
  title: "Job not found",
});

export const idempotencyConflictProblemDescriptor = defineProblem({
  code: "IDEMPOTENCY_CONFLICT",
  description: "The idempotency key conflicts with another request.",
  status: 409,
  title: "Idempotency conflict",
});

export const jobStateProblemDescriptor = defineProblem({
  code: "JOB_STATE_CONFLICT",
  description: "The job is not in a state that permits this operation.",
  status: 409,
  title: "Job state conflict",
});

export const uploadExpiredProblemDescriptor = defineProblem({
  code: "JOB_UPLOAD_EXPIRED",
  description: "The upload window has expired.",
  status: 410,
  title: "Upload expired",
});

export const uploadLimitProblemDescriptor = defineProblem({
  code: "UPLOAD_TOO_LARGE",
  description: "The upload exceeds the job or plan limit.",
  status: 413,
  title: "Upload too large",
});

export const uploadSizeProblemDescriptor = defineProblem({
  code: "UPLOAD_SIZE_MISMATCH",
  description: "The uploaded byte count does not match the declared source size.",
  status: 400,
  title: "Upload size mismatch",
});

export const jobProblem = (error: unknown) => {
  if (error instanceof JobCreditsExhausted) return creditsExhaustedProblem(error.monthlyCredits);
  if (error instanceof JobComparisonDurationExceeded) {
    return comparisonDurationProblem(error.limitSeconds);
  }
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

const creditsExhaustedProblem = (monthlyCredits: number) =>
  makeDescriptorProblem(creditsExhaustedProblemDescriptor, {
    detail: `All ${monthlyCredits} monthly credits are used or reserved.`,
    retryable: false,
    suggestedAction: "Wait for the monthly reset or upgrade the account plan.",
  });

const comparisonDurationProblem = (limitSeconds: number) =>
  makeDescriptorProblem(comparisonDurationProblemDescriptor, {
    detail: `Comparison duration cannot exceed ${limitSeconds} seconds on this server.`,
    retryable: false,
    suggestedAction: "Use the maximum comparison duration reported by capabilities.",
  });

const jobNotFoundProblem = () =>
  makeDescriptorProblem(jobNotFoundProblemDescriptor, {
    detail: "The requested job does not exist.",
    retryable: false,
    suggestedAction: "Check the job ID belongs to the authenticated account.",
  });

const idempotencyConflictProblem = () =>
  makeDescriptorProblem(idempotencyConflictProblemDescriptor, {
    detail: "The idempotency key was already used for a different request.",
    retryable: false,
    suggestedAction: "Retry with the original request or use a new idempotency key.",
  });

const jobStateProblem = (state: string) =>
  makeDescriptorProblem(jobStateProblemDescriptor, {
    detail: `The job cannot perform this operation while it is ${state}.`,
    retryable: false,
    suggestedAction: "Read the current job status before choosing the next action.",
  });

const uploadExpiredProblem = () =>
  makeDescriptorProblem(uploadExpiredProblemDescriptor, {
    detail: "The upload window for this job has expired.",
    retryable: false,
    suggestedAction: "Create a new job and upload its source before the expiry time.",
  });

const uploadLimitProblem = (limitBytes: number) =>
  makeDescriptorProblem(uploadLimitProblemDescriptor, {
    detail: `The source exceeds the ${limitBytes}-byte upload limit.`,
    retryable: false,
    suggestedAction: "Upload a smaller source file.",
  });

const uploadSizeProblem = () =>
  makeDescriptorProblem(uploadSizeProblemDescriptor, {
    detail: "The uploaded byte count does not match the declared source size.",
    retryable: false,
    suggestedAction: "Create a new job with the exact source byte count and retry the upload.",
  });
