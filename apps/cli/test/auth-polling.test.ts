import { afterEach, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

it("reports an interrupted login with exit code 130", async () => {
  const capture = await makeCliCapture();
  const controller = new AbortController();
  controller.abort();
  const server = await startCliServer((_request, response) => {
    sendEnvelope(
      response,
      {
        challengeId: "challenge-1",
        expiresAt: "2026-07-11T13:00:00.000Z",
        pollAfterSeconds: 1,
        pollToken: "poll-secret",
      },
      202,
    );
  });

  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "auth", "login", "agent@example.com"],
    { ...capture.dependencies, signal: controller.signal },
  );
  await server.close();

  expect(exitCode).toBe(130);
  expect(JSON.parse(capture.stderr())).toMatchObject({ code: "CLI_INTERRUPTED" });
});

it("reports interruption while the login request is in flight", async () => {
  const capture = await makeCliCapture();
  const controller = new AbortController();
  const server = await startCliServer(async (_request, response) => {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    sendEnvelope(response, {});
  });

  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "auth", "login", "agent@example.com"],
    { ...capture.dependencies, signal: controller.signal },
  );
  await server.close();

  expect(exitCode).toBe(130);
  expect(JSON.parse(capture.stderr())).toMatchObject({ code: "CLI_INTERRUPTED" });
});

it("reports an expired login challenge explicitly", async () => {
  const capture = await makeCliCapture();
  const server = await startCliServer((_request, response) => {
    sendEnvelope(
      response,
      {
        challengeId: "challenge-1",
        expiresAt: "2026-07-11T11:59:59.000Z",
        pollAfterSeconds: 1,
        pollToken: "poll-secret",
      },
      202,
    );
  });

  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "auth", "login", "agent@example.com"],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(3);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "")).toMatchObject({
    code: "AUTH_CHALLENGE_EXPIRED",
  });
});

it("retries a transient login poll failure", async () => {
  const capture = await makeCliCapture();
  let pollAttempts = 0;
  const server = await startCliServer((request, response) => {
    if (request.url === "/v1/auth/login") {
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
    pollAttempts += 1;
    if (pollAttempts === 1) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/problem+json");
      response.end(
        JSON.stringify({
          code: "TEMPORARY_FAILURE",
          correlationId: "poll-1",
          detail: "Try again.",
          retryable: true,
          schemaVersion: 1,
          status: 503,
          suggestedAction: "Retry.",
          title: "Temporary failure",
          type: "about:blank",
        }),
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
  expect(pollAttempts).toBe(2);
});
