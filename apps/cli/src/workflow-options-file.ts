import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Option, Result, Schema } from "effect";
import { CliUsageError } from "./cli-errors.ts";
import { singleFlag, type ParsedCommandArguments } from "./command-options.ts";

const executionFlags = new Set([
  "--options-file",
  "--idempotency-key",
  "--max-credits",
  "--max-output-bytes",
  "--client-reference",
  "--destination",
  "--visibility",
  "--name",
  "--output-dir",
  "--timeout",
  "--until",
  "--no-wait",
  "--force",
]);
export const readWorkflowOptions = (parsed: ParsedCommandArguments) => {
  const path = singleFlag(parsed, "--options-file");
  if (path === undefined) return undefined;
  if ([...parsed.flags.keys(), ...parsed.switches].some((flag) => !executionFlags.has(flag)))
    throw new CliUsageError("Do not mix --options-file with individual workflow option flags.");
  const opened = Result.try({
    try: () => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    catch: () =>
      new CliUsageError("--options-file must name a readable regular JSON file, without symlinks."),
  });
  if (Result.isFailure(opened)) throw opened.failure;
  const descriptor = opened.success;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 65536)
      throw new CliUsageError("Workflow options must be a regular JSON file of at most 64 KiB.");
    const decoded = Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(readFileSync(descriptor, "utf8"));
    if (Option.isNone(decoded))
      throw new CliUsageError("--options-file must contain one workflow options JSON object.");
    return decoded.value;
  } finally {
    closeSync(descriptor);
  }
};
