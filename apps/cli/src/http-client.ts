import { ProblemDetailsSchema } from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import { CliProblemError, invalidResponseError, networkError } from "./cli-errors.ts";
import type { CliRuntime } from "./runtime.ts";

type ResponseDecoder<Value> = (input: unknown) => Effect.Effect<Value, unknown>;

const decodeProblem = Schema.decodeUnknownEffect(ProblemDetailsSchema);

export const requestJson = async <Value>(
  runtime: CliRuntime,
  path: string,
  init: RequestInit,
  decode: ResponseDecoder<Value>,
) => {
  const response = await runtime
    .fetch(resolveRequestUrl(runtime.apiUrl, path), {
      ...init,
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    })
    .catch(() => Promise.reject(networkError("The API request could not be completed.")));
  const body = await response.json().catch(() => Promise.reject(invalidResponseError()));
  if (!response.ok) {
    throw new CliProblemError(await decodeProblemBody(body));
  }

  return Effect.runPromise(decode(body)).catch(() => Promise.reject(invalidResponseError()));
};

export const jsonRequest = (
  method: string,
  body?: unknown,
  headers: RequestInit["headers"] = {},
) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const resolveRequestUrl = (apiUrl: string, path: string) =>
  new URL(path, `${apiUrl}/`).toString();

export const decodeProblemResponse = async (response: Response) => {
  const body = await response.json().catch(() => Promise.reject(invalidResponseError()));
  return decodeProblemBody(body);
};

const decodeProblemBody = (body: unknown) =>
  Effect.runPromise(decodeProblem(body)).catch(() => Promise.reject(invalidResponseError()));
