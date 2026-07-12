import { ArtifactUnavailable } from "../../database/artifact-repository.ts";
import { makeProblem } from "../../errors/problem-details.ts";
import { RangeNotSatisfiable } from "../../storage/byte-range.ts";

export const storageProblem = (error: unknown) => {
  if (error instanceof ArtifactUnavailable) return artifactNotFoundProblem();
  if (error instanceof RangeNotSatisfiable) return rangeProblem();
  return undefined;
};

const artifactNotFoundProblem = () =>
  makeProblem({
    code: "ARTIFACT_NOT_FOUND",
    detail: "The artifact link is invalid, expired, or no longer available.",
    retryable: false,
    status: 404,
    suggestedAction: "Use an unexpired download link from the job result.",
    title: "Artifact not found",
  });

const rangeProblem = () =>
  makeProblem({
    code: "RANGE_NOT_SATISFIABLE",
    detail: "The requested byte range is not available for this artifact.",
    retryable: false,
    status: 416,
    suggestedAction: "Request a single byte range within the artifact size.",
    title: "Range not satisfiable",
  });
