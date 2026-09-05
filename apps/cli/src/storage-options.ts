import { StorageDestinationSchema, StorageSelectionSchema } from "@densio/shared";
import { decodeCliOptions, singleFlag } from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";

export const parseDestination = (value: string) =>
  decodeCliOptions(
    StorageDestinationSchema,
    value === "temporary"
      ? { kind: "temporary" }
      : value === "densio"
        ? { kind: "managed" }
        : { kind: "connection", connectionId: value },
    "storage destination",
  );
export const parseStorageSelection = (parsed: Parameters<typeof singleFlag>[0]) => {
  const destination = singleFlag(parsed, "--destination");
  const name = singleFlag(parsed, "--name");
  const visibility = singleFlag(parsed, "--visibility");
  if (destination === undefined) {
    if (name !== undefined || visibility !== undefined)
      throw new CliUsageError("--name and --visibility require --destination.");
    return {};
  }
  return {
    storage: decodeCliOptions(
      StorageSelectionSchema,
      {
        destination: parseDestination(destination),
        ...(name === undefined ? {} : { name }),
        ...(visibility === undefined ? {} : { visibility }),
      },
      "storage selection",
    ),
  };
};
export const parseUntil = (
  parsed: Parameters<typeof singleFlag>[0],
): "compressed" | "stored" | undefined => {
  const value = singleFlag(parsed, "--until");
  if (value !== undefined && value !== "compressed" && value !== "stored")
    throw new CliUsageError("--until must be compressed or stored.");
  return value;
};
