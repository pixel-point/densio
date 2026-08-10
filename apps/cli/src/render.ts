import type { JobStatus, SuccessEnvelope } from "@densio/shared";

import type { CliProblemError } from "./cli-errors.ts";
import { formatJsonProblem, formatJsonSuccess, formatProgress } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";

export const emitSuccess = (
  runtime: CliRuntime,
  envelope: SuccessEnvelope<unknown>,
  humanText: string,
) => runtime.writeStdout(runtime.json ? formatJsonSuccess(envelope) : humanText);

export const emitProblem = (runtime: CliRuntime, error: CliProblemError) => {
  if (runtime.json) {
    runtime.writeStderr(formatJsonProblem(error.problem));
    return;
  }
  runtime.writeStderr(`${error.problem.title}: ${error.problem.detail}\n`);
  runtime.writeStderr(`${error.problem.suggestedAction}\n`);
};

export const emitProgress = (runtime: CliRuntime, status: JobStatus) => {
  if (status.state === "succeeded" || status.state === "expired") return;
  const progress = runtime.json
    ? `${JSON.stringify({
        jobId: status.id,
        progressPercent: status.progressPercent,
        state: status.state,
        type: "progress",
      })}\n`
    : formatProgress(status.id, status.state, status.progressPercent);
  runtime.writeStderr(progress);
};

export const emitStatusEvent = (
  runtime: CliRuntime,
  event: Readonly<Record<string, string>>,
  humanText: string,
) => runtime.writeStderr(runtime.json ? `${JSON.stringify(event)}\n` : humanText);

export const formatJobStatus = (status: JobStatus) => {
  if (status.state === "awaiting-decision") {
    const framesPerSecond = status.decision.source.framesPerSecond.toFixed(2);
    return [
      `${status.id} awaits a frame-rate decision.`,
      `Detected ${framesPerSecond} fps; 30 fps is recommended for most web video.`,
      `densio jobs decide-frame-rate ${status.id} cap-30`,
      `densio jobs decide-frame-rate ${status.id} preserve`,
      "",
    ].join("\n");
  }
  if (status.state !== "succeeded") return `${status.id} ${status.state}.\n`;
  if (status.result.kind === "compress") {
    const links = status.result.artifacts
      .map((artifact) => `${artifact.filename}: ${artifact.downloadUrl}`)
      .join("\n");
    return `${status.id} succeeded.\n${links}\n${status.result.html}\n`;
  }
  if (status.result.kind === "extract-images") {
    return `${status.id} succeeded.\n${status.result.archive.downloadUrl}\n`;
  }
  const links = status.result.variants
    .flatMap((variant) => [variant.preview.downloadUrl, variant.still.downloadUrl])
    .join("\n");
  return `${status.id} succeeded.\n${links}\n`;
};
