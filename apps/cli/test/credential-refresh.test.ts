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
      sessionExpiresAt: "2026-07-11T14:00:00.000Z",
      user: { email: "agent@example.com", id: "user-1", plan: "pro" },
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
