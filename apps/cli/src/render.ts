import type { JobStatus, SuccessEnvelope } from "@densio/shared";

import type { CliProblemError } from "./cli-errors.ts";
import { formatJsonProblem, formatJsonSuccess } from "./output.ts";
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

export const emitStatusEvent = (
  runtime: CliRuntime,
  event: Readonly<Record<string, string>>,
  humanText: string,
) => runtime.writeStderr(runtime.json ? `${JSON.stringify(event)}\n` : humanText);

export const formatJobStatus = (status: JobStatus) => {
  if (status.state !== "succeeded")
    return `${status.id} ${status.state} (${Math.round(status.progress.percent)}%).\n`;
  if (status.video)
    return `${status.id} succeeded; ${status.video.videoId} ${status.video.state}.\n${status.video.embedHtml ?? ""}\n`;
  const artifacts = status.artifacts
    .map((artifact) => `${artifact.filename}: ${artifact.id} (${artifact.availability})`)
    .join("\n");
  return `${status.id} succeeded.\n${artifacts}\nMaterialize with densio --org ${status.organizationId} artifacts materialize ${status.id} --output-dir DIR.\n`;
};
