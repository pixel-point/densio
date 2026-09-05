import { stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { readCredentials, writeCredentials } from "../src/config.ts";
import { runCli } from "../src/cli.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("authentication commands", () => {
  it("polls a magic-link challenge and persists secrets without printing them", async () => {
    const capture = await makeCliCapture();
    const emails: Array<string> = [];
    const server = await startCliServer(async (request, response) => {
      if (request.url === "/v1/auth/login") {
        emails.push(JSON.parse((await readRequestBody(request)).toString()).email);
        sendEnvelope(
          response,
          {
            challengeId: "challenge-1",
            expiresAt: "2026-07-11T13:00:00.000Z",
            pollAfterSeconds: 0.001,
            pollToken: "poll-secret",
          },
          202,
        );
        return;
      }
      sendEnvelope(response, {
        accessToken: "access-secret",
        accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
        refreshToken: "refresh-secret",
        status: "confirmed",
      });
    });

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "auth", "login", "agent@example.com"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(emails).toEqual(["agent@example.com"]);
    expect(JSON.parse(capture.stdout())).toMatchObject({
      data: { authenticated: true, expiresAt: "2026-07-11T14:00:00.000Z" },
      ok: true,
      schemaVersion: 1,
    });
    expect(JSON.parse(capture.stderr())).toEqual({
      state: "waiting-confirmation",
      type: "progress",
    });
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("poll-secret");
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("access-secret");
    expect(`${capture.stdout()}${capture.stderr()}`).not.toContain("refresh-secret");
    expect(await readCredentials(capture.dependencies.credentialsPath)).toMatchObject({
      accessToken: "access-secret",
      apiUrl: server.url,
      refreshToken: "refresh-secret",
    });
    expect((await stat(capture.dependencies.credentialsPath)).mode & 0o777).toBe(0o600);
  });
});

describe("authenticated session commands", () => {
  it("rotates an expired session before status and revokes it on logout", async () => {
    const capture = await makeCliCapture();
    const authorizations: Array<string | undefined> = [];
    const server = await startCliServer(async (request, response) => {
      if (request.url === "/v1/auth/refresh") {
        expect(JSON.parse((await readRequestBody(request)).toString())).toEqual({
          refreshToken: "old-refresh",
        });
        sendEnvelope(response, {
          accessToken: "new-access",
          accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
          refreshToken: "new-refresh",
        });
        return;
      }
      authorizations.push(request.headers.authorization);
      if (request.url === "/v1/auth/logout") {
        sendEnvelope(response, { revoked: true });
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

    expect(
      await runCli(["--json", "--api-url", server.url, "auth", "status"], capture.dependencies),
    ).toBe(0);
    expect(JSON.parse(capture.stdout()).data.defaultOrganizationId).toBe("org-1");
    expect(await readCredentials(capture.dependencies.credentialsPath)).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    const logout = await makeCliCapture();
    await writeCredentials(logout.dependencies.credentialsPath, {
      accessToken: "new-access",
      accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
      apiUrl: server.url,
      refreshToken: "new-refresh",
    });
    expect(
      await runCli(["--json", "--api-url", server.url, "auth", "logout"], logout.dependencies),
    ).toBe(0);
    await server.close();

    expect(authorizations).toEqual(["Bearer new-access", "Bearer new-access"]);
    await expect(readCredentials(logout.dependencies.credentialsPath)).resolves.toBeUndefined();
  });
});
