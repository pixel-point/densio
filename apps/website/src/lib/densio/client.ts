import "server-only";
import { ProblemDetailsSchema, successEnvelope } from "@densio/shared";
import { Result, Schema } from "effect";

export type ApiFailure = {
  code: string;
  status: number;
  title: string;
  detail: string;
  retryable: boolean;
};
export type ApiResult<Value> = { ok: true; data: Value } | { ok: false; error: ApiFailure };
type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  token?: string;
  idempotencyKey?: string;
};

export const createDensioClient =
  (baseUrl: string, timeoutMs = 10_000) =>
  async <S extends Schema.Top & { readonly DecodingServices: never }>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<ApiResult<S["Type"]>> => {
    const url = new URL(path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith("/v1/"))
      return unavailable();
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }).then(
      (value) => value,
      () => null,
    );
    if (!response) return unavailable();
    const body: unknown = await response.json().then(
      (value: unknown) => value,
      () => null,
    );
    if (!response.ok) {
      const problem = Schema.decodeUnknownResult(ProblemDetailsSchema)(body);
      if (Result.isSuccess(problem)) return { ok: false, error: problem.success };
      return {
        ok: false,
        error: {
          code: "API_UNAVAILABLE",
          status: response.status,
          title: "Densio is unavailable",
          detail: "We could not complete this request. Please try again.",
          retryable: true,
        },
      };
    }
    const decoded = Schema.decodeUnknownResult(successEnvelope(Schema.Unknown))(body);
    if (Result.isFailure(decoded)) return invalidResponse();
    const data = Schema.decodeUnknownResult(schema)(decoded.success.data);
    if (Result.isFailure(data)) return invalidResponse();
    return { ok: true, data: data.success };
  };

const unavailable = (): ApiResult<never> => ({
  ok: false,
  error: {
    code: "API_UNAVAILABLE",
    status: 503,
    title: "Densio is unavailable",
    detail: "We could not reach Densio. Please try again in a moment.",
    retryable: true,
  },
});

const invalidResponse = (): ApiResult<never> => ({
  ok: false,
  error: {
    code: "API_RESPONSE_INVALID",
    status: 502,
    title: "Unable to load this page",
    detail: "Densio returned an unexpected response. Please try again.",
    retryable: true,
  },
});
