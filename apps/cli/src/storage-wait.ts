import type { JobStatus } from "@densio/shared";
import { CliProblemError, CliUsageError } from "./cli-errors.ts";

export const isJobDeliveryComplete = (status: JobStatus, until?: "compressed" | "stored") => {
  if (status.state !== "succeeded") return false;
  if (until === "compressed") return true;
  if (!status.video) {
    if (until === "stored")
      throw new CliUsageError(
        "This job has no automatic storage intent. Save it with videos save JOB_ID --destination DESTINATION.",
      );
    return true;
  }
  const video = status.video;
  if (video.state === "ready") return true;
  if (
    ["storage-blocked", "storage-failed", "unavailable", "deleted", "deleting"].includes(
      video.state,
    )
  )
    throw new CliProblemError({
      schemaVersion: 1,
      code: video.errorCode ?? "STORAGE_INVALID_STATE",
      correlationId: "local",
      jobId: status.id,
      status: 409,
      title: "Video storage needs attention",
      detail: `Compression succeeded; video ${video.videoId} is ${video.state}.`,
      retryable: false,
      suggestedAction: `Inspect densio --org ${status.organizationId} videos get ${video.videoId}; retry storage after resolving the reported problem.`,
      type: "about:blank",
    });
  return false;
};
