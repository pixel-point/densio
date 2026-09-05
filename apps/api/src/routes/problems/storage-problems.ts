import { ArtifactUnavailable } from "../../database/artifact-repository.ts";
import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import { RangeNotSatisfiable } from "../../storage/byte-range.ts";

export const artifactNotFoundProblemDescriptor = defineProblem({
  code: "ARTIFACT_NOT_FOUND",
  description:
    "The download grant is invalid, expired, or revoked, or the artifact is unavailable.",
  status: 404,
  title: "Artifact not found",
});

export const rangeProblemDescriptor = defineProblem({
  code: "RANGE_NOT_SATISFIABLE",
  description: "The requested byte range cannot be satisfied.",
  status: 416,
  title: "Range not satisfiable",
});

export const storageProblem = (error: unknown) => {
  if (error instanceof ArtifactUnavailable) return artifactNotFoundProblem();
  if (error instanceof RangeNotSatisfiable) return rangeProblem();
  return undefined;
};

const artifactNotFoundProblem = () =>
  makeDescriptorProblem(artifactNotFoundProblemDescriptor, {
    detail: "The artifact link is invalid, expired, or no longer available.",
    retryable: false,
    suggestedAction: "Use an unexpired download link from the job result.",
  });

const rangeProblem = () =>
  makeDescriptorProblem(rangeProblemDescriptor, {
    detail: "The requested byte range is not available for this artifact.",
    retryable: false,
    suggestedAction: "Request a single byte range within the artifact size.",
  });
