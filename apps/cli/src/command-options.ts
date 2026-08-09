import { Result, Schema } from "effect";

import type { TransformOptions } from "@densio/shared";

import { CliUsageError } from "./cli-errors.ts";

export interface ParsedCommandArguments {
  readonly flags: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly positionals: ReadonlyArray<string>;
  readonly switches: ReadonlySet<string>;
}

export const parseCommandArguments = (
  argv: ReadonlyArray<string>,
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
) => {
  const flags = new Map<string, Array<string>>();
  const positionals: Array<string> = [];
  const switches = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      if (argument !== undefined) positionals.push(argument);
      continue;
    }
    if (booleanFlags.has(argument)) {
      switches.add(argument);
      continue;
    }
    if (!valueFlags.has(argument)) throw new CliUsageError(`Unknown option: ${argument}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${argument} requires a value.`);
    }
    flags.set(argument, [...(flags.get(argument) ?? []), value]);
    index += 1;
  }

  return { flags, positionals, switches } satisfies ParsedCommandArguments;
};

export const singleFlag = (parsed: ParsedCommandArguments, name: string) => {
  const values = parsed.flags.get(name) ?? [];
  if (values.length > 1) throw new CliUsageError(`${name} may only be provided once.`);
  return values[0];
};

export const numberFlag = (parsed: ParsedCommandArguments, name: string) => {
  const value = singleFlag(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CliUsageError(`${name} requires a finite number.`);
  return number;
};

export const commaSeparatedFlags = (parsed: ParsedCommandArguments, name: string) =>
  (parsed.flags.get(name) ?? []).flatMap((value) => value.split(",")).filter(Boolean);

export const requireSinglePositional = (parsed: ParsedCommandArguments, usage: string) => {
  if (parsed.positionals.length !== 1) throw new CliUsageError(usage);
  return parsed.positionals[0] ?? "";
};

export const buildTransformOptions = (parsed: ParsedCommandArguments) => {
  const width = numberFlag(parsed, "--width");
  const height = numberFlag(parsed, "--height");
  if (width !== undefined && height !== undefined) {
    throw new CliUsageError("Use only one of --width or --height.");
  }
  const allowUpscale = parsed.switches.has("--allow-upscale");
  if (allowUpscale && width === undefined && height === undefined) {
    throw new CliUsageError("--allow-upscale requires --width or --height.");
  }
  const aspectRatio = singleFlag(parsed, "--crop-aspect");
  const rectangle = singleFlag(parsed, "--crop-rect");
  if (aspectRatio !== undefined && rectangle !== undefined) {
    throw new CliUsageError("Use only one crop mode.");
  }
  const scale =
    width === undefined
      ? height === undefined
        ? undefined
        : { height, ...(allowUpscale ? { allowUpscale } : {}) }
      : { width, ...(allowUpscale ? { allowUpscale } : {}) };
  const crop =
    aspectRatio === undefined
      ? rectangle === undefined
        ? undefined
        : parseRectangle(rectangle)
      : { aspectRatio, kind: "aspect-ratio" as const };
  if (scale === undefined && crop === undefined) return undefined;
  return { ...(crop === undefined ? {} : { crop }), ...(scale === undefined ? {} : { scale }) };
};

export const decodeCliOptions = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  command: string,
): S["Type"] => {
  const result = Schema.decodeUnknownResult(schema)(input);
  if (Result.isFailure(result)) throw new CliUsageError(`${command} options are invalid.`);
  return result.success;
};

const parseRectangle = (input: string): NonNullable<TransformOptions["crop"]> => {
  const values = input.split(":").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isSafeInteger(value))) {
    throw new CliUsageError("--crop-rect must use width:height:x:y integers.");
  }
  const [width, height, x, y] = values;
  return { height: height ?? 0, kind: "rectangle", width: width ?? 0, x: x ?? 0, y: y ?? 0 };
};

export const commonMediaValueFlags = new Set([
  "--crop-aspect",
  "--crop-rect",
  "--height",
  "--idempotency-key",
  "--timeout",
  "--width",
]);

export const commonMediaBooleanFlags = new Set(["--allow-upscale", "--no-wait"]);
