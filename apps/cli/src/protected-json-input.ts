import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Option, Schema } from "effect";
import { CliUsageError } from "./cli-errors.ts";

export const readProtectedJson = async <
  S extends Schema.Top & Schema.ConstraintDecoder<unknown, never>,
>(
  path: string,
  schema: S,
): Promise<S["Type"]> => {
  const text = path === "-" ? await readStandardInput() : await readProtectedFile(path);
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(text);
  if (Option.isNone(decoded))
    throw new CliUsageError(
      "The protected storage configuration does not match the required JSON schema.",
    );
  return decoded.value;
};
const readProtectedFile = async (path: string) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new CliUsageError("Cannot open the storage configuration file.");
  });
  return Promise.resolve()
    .then(async () => {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 65_536 ||
        (process.platform !== "win32" &&
          ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())))
      )
        throw new CliUsageError(
          "Storage configuration must be an owner-only regular file of at most 64 KiB; use chmod 600.",
        );
      return file.readFile("utf8");
    })
    .finally(() => file.close());
};
const readStandardInput = async () => {
  if (process.stdin.isTTY)
    throw new CliUsageError("Pipe JSON into stdin or provide an owner-only --config file.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 65_536) throw new CliUsageError("Storage configuration must be at most 64 KiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
};
