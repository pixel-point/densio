import { invalidResponseError } from "./cli-errors.ts";
import type { CliRuntime } from "./runtime.ts";

export const controlRequestUrl = (runtime: CliRuntime, path: string) => {
  const url = new URL(path, `${runtime.apiUrl}/`);
  if (url.origin !== new URL(runtime.apiUrl).origin || url.username !== "" || url.password !== "")
    throw invalidResponseError();
  return url;
};
