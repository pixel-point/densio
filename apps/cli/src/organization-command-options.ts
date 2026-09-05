import { Schema } from "effect";
import {
  decodeCliOptions,
  numberFlag,
  singleFlag,
  type ParsedCommandArguments,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";

export const directoryQuery = <S extends Schema.ConstraintDecoder<unknown>>(
  parsed: ParsedCommandArguments,
  schema: S,
  command: string,
) => {
  if (parsed.positionals.length > 0) throw new CliUsageError(`${command} accepts only filters.`);
  const query = decodeCliOptions(
    schema,
    Object.fromEntries(
      Object.entries({
        cursor: singleFlag(parsed, "--cursor"),
        limit: numberFlag(parsed, "--limit"),
        state: singleFlag(parsed, "--state"),
        after: numberFlag(parsed, "--after"),
      }).filter(([, value]) => value !== undefined),
    ),
    command,
  );
  const encoded = new URLSearchParams(
    Object.entries(query as Readonly<Record<string, unknown>>).map(
      ([key, value]): [string, string] => [key, String(value)],
    ),
  );
  return encoded.size === 0 ? "" : `?${encoded}`;
};
