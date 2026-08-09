import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AuthTokensSchema, HttpUrlSchema } from "@densio/shared";
import { Predicate, Schema } from "effect";

import { CliUsageError } from "./cli-errors.ts";

interface ApiUrlSources {
  readonly configApiUrl?: string;
  readonly environmentApiUrl?: string;
  readonly flagApiUrl?: string;
}

const CliCredentialsSchema = Schema.Struct({
  ...AuthTokensSchema.fields,
  apiUrl: HttpUrlSchema,
});
export type CliCredentials = typeof CliCredentialsSchema.Type;
const decodeCredentials = Schema.decodeUnknownSync(Schema.fromJsonString(CliCredentialsSchema));

export const resolveApiUrl = ({ configApiUrl, environmentApiUrl, flagApiUrl }: ApiUrlSources) =>
  normalizeApiUrl(flagApiUrl ?? environmentApiUrl ?? configApiUrl ?? "https://api.densio.sh");

export const writeCredentials = async (path: string, credentials: CliCredentials) => {
  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const storedCredentials = { ...credentials, apiUrl: credentialApiOrigin(credentials.apiUrl) };
  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(storedCredentials, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, path).catch(async (cause: unknown) => {
    await rm(temporaryPath, { force: true });
    throw cause;
  });
  await chmod(path, 0o600);
};

export const readCredentials = async (path: string) => {
  const content = await readFile(path, "utf8").catch((cause: unknown) => {
    if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") return undefined;
    throw cause;
  });

  return content === undefined ? undefined : decodeCredentials(content);
};

export const clearCredentials = (path: string) => rm(path, { force: true });

export const credentialApiOrigin = (apiUrl: string) =>
  new URL(resolveApiUrl({ flagApiUrl: apiUrl })).origin;

const normalizeApiUrl = (input: string) => {
  if (!URL.canParse(input)) throw new CliUsageError("API URL is invalid.");
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliUsageError("API URL must use HTTP or HTTPS.");
  }
  url.username = "";
  url.password = "";

  return url.toString().replace(/\/$/, "");
};
