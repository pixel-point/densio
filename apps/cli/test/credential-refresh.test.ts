import { Schema } from "effect";
import { createAuthenticatedClient } from "../src/authenticated-client.ts";
import { withCredentialLock } from "../src/credential-lock.ts";
import { pollUntilComplete } from "../src/polling.ts";
import { makeCliRuntime } from "../src/runtime.ts";
import { afterEach, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { readCredentials, writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

it("serializes concurrent refreshes across CLI invocations", async () => {
  const capture = await makeCliCapture();
  let refreshRequests = 0;
  const server = await startCliServer(async (request, response) => {
    if (request.url === "/v1/auth/refresh") {
      refreshRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      sendEnvelope(response, {
        accessToken: "new-access",
        accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
        refreshToken: "new-refresh",
      });
      return;
    }
    sendEnvelope(response, {
      authenticated: true,
      defaultOrganizationId: "org-1",
      sessionExpiresAt: "2026-07-11T14:00:00.000Z",
      user: { email: "agent@example.com", id: "user-1" },
    });
  });
  await writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "expired-access",
    accessTokenExpiresAt: "2026-07-11T11:00:00.000Z",
    apiUrl: server.url,
    refreshToken: "old-refresh",
  });
  const dependencies = {
    ...capture.dependencies,
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  };

  const exitCodes = await Promise.all([
    runCli(["--json", "--api-url", server.url, "auth", "status"], dependencies),
    runCli(["--json", "--api-url", server.url, "auth", "status"], dependencies),
  ]);
  await server.close();

  expect(exitCodes).toEqual([0, 0]);
  expect(refreshRequests).toBe(1);
  expect(await readCredentials(capture.dependencies.credentialsPath)).toMatchObject({
    accessToken: "new-access",
    refreshToken: "new-refresh",
  });
});

it("a polling deadline aborts token refresh and releases its credential lock", async () => {
  const capture = await makeCliCapture();
  let refreshing = false;
  const server = await startCliServer((request, response) => {
    if (request.url === "/v1/auth/refresh") {
      refreshing = true;
      return;
    }
    sendEnvelope(response, {
      authenticated: true,
      defaultOrganizationId: "org-1",
      sessionExpiresAt: "2099-01-01T00:00:00.000Z",
      user: { email: "agent@example.com", id: "user-1" },
    });
  });
  const credentials = {
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    apiUrl: server.url,
  };
  const runtime = makeCliRuntime(
    { apiUrl: server.url, credentialsPath: capture.dependencies.credentialsPath, json: true },
    {},
  );
  try {
    await writeCredentials(runtime.credentialsPath, credentials);
    const client = await createAuthenticatedClient(runtime);
    await writeCredentials(runtime.credentialsPath, {
      ...credentials,
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(
      pollUntilComplete({
        runtime,
        deadlineAt: Date.now() + 100,
        initialDelayMilliseconds: 0,
        interruptedError: () => new Error("interrupted"),
        timeoutError: () => new Error("deadline"),
        isRetryableFailure: () => false,
        poll: (signal: AbortSignal) =>
          client.request("/unused", { signal }, Schema.decodeUnknownEffect(Schema.String)),
        decide: (value) => ({ kind: "complete", value }),
      }),
    ).rejects.toThrow("deadline");
    expect(refreshing).toBe(true);
    // Acquiring the same real lock must succeed after abort cleanup.
    await withCredentialLock(
      runtime.credentialsPath,
      { ...runtime, signal: AbortSignal.timeout(1000) },
      async () => undefined,
    );
  } finally {
    await server.close();
  }
});
