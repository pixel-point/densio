import { AuthTokensSchema, successEnvelope } from "@ffmpeg-api/shared";
import { Schema } from "effect";

import { credentialApiOrigin, readCredentials, writeCredentials } from "./config.ts";
import { authenticationRequiredError } from "./cli-errors.ts";
import { withCredentialLock } from "./credential-lock.ts";
import { jsonRequest, requestJson } from "./http-client.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeAuthTokens = Schema.decodeUnknownEffect(successEnvelope(AuthTokensSchema));

export const accessToken = async (runtime: CliRuntime, required: boolean) => {
  const credentials = await readCredentials(runtime.credentialsPath);
  if (credentials === undefined) {
    if (required) throw authenticationRequiredError();
    return undefined;
  }
  if (credentials.apiUrl !== credentialApiOrigin(runtime.apiUrl)) {
    if (required) throw authenticationRequiredError();
    return undefined;
  }
  if (Date.parse(credentials.accessTokenExpiresAt) > runtime.now() + 30_000) {
    return credentials.accessToken;
  }

  return withCredentialLock(runtime.credentialsPath, runtime, async () => {
    const current = await readCredentials(runtime.credentialsPath);
    if (current === undefined || current.apiUrl !== credentialApiOrigin(runtime.apiUrl)) {
      if (required) throw authenticationRequiredError();
      return undefined;
    }
    if (Date.parse(current.accessTokenExpiresAt) > runtime.now() + 30_000) {
      return current.accessToken;
    }
    return (await refreshCredentials(runtime, current.refreshToken)).accessToken;
  });
};

export const authorizationHeaders = async (runtime: CliRuntime, required = true) => {
  const token = await accessToken(runtime, required);
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
};

const refreshCredentials = async (runtime: CliRuntime, refreshToken: string) => {
  const response = await requestJson(
    runtime,
    "/v1/auth/refresh",
    jsonRequest("POST", { refreshToken }),
    decodeAuthTokens,
  );
  const credentials = { ...response.data, apiUrl: credentialApiOrigin(runtime.apiUrl) };
  await writeCredentials(runtime.credentialsPath, credentials);
  return credentials;
};
