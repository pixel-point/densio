import { AuthStatusSchema, successEnvelope } from "@densio/shared";
import { Schema } from "effect";
import { accessToken } from "./authentication.ts";
import { authenticationRequiredError } from "./cli-errors.ts";
import { requestJson, requestSignal, type ResponseDecoder } from "./http-client.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeIdentity = Schema.decodeUnknownEffect(successEnvelope(AuthStatusSchema));

export const createAuthenticatedClient = async (runtime: CliRuntime) => {
  const initialToken = await accessToken(runtime, true);
  if (initialToken === undefined) throw authenticationRequiredError();
  const initial = await requestJson(
    runtime,
    "/v1/auth/status",
    { headers: { authorization: `Bearer ${initialToken}` } },
    decodeIdentity,
  );
  if (!initial.data.authenticated) throw authenticationRequiredError();
  const identity = initial.data;
  let verifiedToken = initialToken;
  return {
    userId: identity.user.id,
    defaultOrganizationId: identity.defaultOrganizationId,
    request: async <Value>(path: string, init: RequestInit, decode: ResponseDecoder<Value>) => {
      const requestRuntime = { ...runtime, signal: requestSignal(runtime, init) };
      const token = await accessToken(requestRuntime, true);
      if (token === undefined) throw authenticationRequiredError();
      if (token !== verifiedToken) {
        const current = await requestJson(
          requestRuntime,
          "/v1/auth/status",
          { headers: { authorization: `Bearer ${token}` } },
          decodeIdentity,
        );
        if (!current.data.authenticated || current.data.user.id !== identity.user.id)
          throw authenticationRequiredError();
        verifiedToken = token;
      }
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return requestJson(requestRuntime, path, { ...init, headers }, decode);
    },
  };
};
export type AuthenticatedClient = Awaited<ReturnType<typeof createAuthenticatedClient>>;
