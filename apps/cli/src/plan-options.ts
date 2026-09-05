import { parseTrimOptions } from "./trim-options.ts";
import { readWorkflowOptions } from "./workflow-options-file.ts";
import { parseHlsOptions } from "./hls-options.ts";
import { parseStorageSelection } from "./storage-options.ts";
import { ExecutionPlanCreateRequestSchema } from "@densio/shared";

import { parseCatalogCommand } from "./command-catalog.ts";
import { decodeCliOptions, numberFlag, singleFlag } from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import {
  parseComparisonOptions,
  parseCompressionOptions,
  parseExtractionOptions,
} from "./media-options.ts";

export const parsePlanCreate = (
  argv: ReadonlyArray<string>,
  command: "plans create" | "jobs create" = "plans create",
) => {
  const [sourceId, workflow, ...optionArguments] = argv;
  if (
    sourceId === undefined ||
    (workflow !== "compress" &&
      workflow !== "extract-images" &&
      workflow !== "compare-quality" &&
      workflow !== "hls" &&
      workflow !== "trim")
  ) {
    throw new CliUsageError(
      `${command} requires a source ID and compress, extract-images, compare-quality, hls, or trim.`,
    );
  }
  const parsed = parseCatalogCommand(`${command} ${workflow}`, optionArguments);
  if (parsed.positionals.length > 0) throw new CliUsageError("Unexpected planning arguments.");
  const fileOptions = readWorkflowOptions(parsed);
  const options =
    fileOptions ??
    (workflow === "trim"
      ? parseTrimOptions(parsed)
      : workflow === "hls"
        ? parseHlsOptions(parsed)
        : workflow === "compress"
          ? parseCompressionOptions(parsed)
          : workflow === "extract-images"
            ? parseExtractionOptions(parsed)
            : parseComparisonOptions(parsed));
  const maxCredits = numberFlag(parsed, "--max-credits");
  const maxOutputBytes = numberFlag(parsed, "--max-output-bytes");
  const idempotencyKey = singleFlag(parsed, "--idempotency-key");
  return {
    parsed,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    request: decodeCliOptions(
      ExecutionPlanCreateRequestSchema,
      {
        sourceId,
        workflow,
        ...(workflow === "compress" || workflow === "trim" || workflow === "hls"
          ? parseStorageSelection(parsed)
          : {}),
        options,
        ...(maxCredits === undefined && maxOutputBytes === undefined
          ? {}
          : {
              constraints: {
                ...(maxCredits === undefined ? {} : { maxCredits }),
                ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
              },
            }),
      },
      command,
    ),
  };
};
