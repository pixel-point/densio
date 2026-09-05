import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import { JobNotFound } from "../../jobs/job-errors.ts";

export const jobNotFoundProblemDescriptor = defineProblem({
  code: "JOB_NOT_FOUND",
  description: "The job does not exist for this user.",
  status: 404,
  title: "Job not found",
});
export const jobProblem = (error: unknown) =>
  error instanceof JobNotFound
    ? makeDescriptorProblem(jobNotFoundProblemDescriptor, {
        detail: "The requested job does not exist.",
        retryable: false,
        suggestedAction: "Check the job ID belongs to the authenticated account.",
      })
    : undefined;
