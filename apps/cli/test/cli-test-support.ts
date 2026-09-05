import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const temporaryCliDirectories: Array<string> = [];

export const makeCliCapture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-cli-"));
  temporaryCliDirectories.push(directory);
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];

  return {
    dependencies: {
      credentialsPath: join(directory, "credentials.json"),
      now: () => Date.parse("2026-07-11T12:00:00.000Z"),
      sleep: async () => undefined,
      writeStderr: (text: string) => stderr.push(text),
      writeStdout: (text: string) => stdout.push(text),
    },
    directory,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  } as const;
};

export const cleanupCliDirectories = async () => {
  await Promise.all(
    temporaryCliDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
};

export const startCliServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
) => {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((cause: unknown) => {
      response.statusCode = 500;
      response.end(String(cause));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server has no port");

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}`,
  } as const;
};

export const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export const sendEnvelope = (response: ServerResponse, data: unknown, status = 200) => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ correlationId: "test-correlation", data, ok: true, schemaVersion: 1 }),
  );
};

export const sendRouteNotFound = (response: ServerResponse) => {
  response.statusCode = 404;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      code: "ROUTE_NOT_FOUND",
      correlationId: "test-correlation",
      detail: "The route does not exist on this server version.",
      retryable: false,
      schemaVersion: 1,
      status: 404,
      suggestedAction: "Use job status polling.",
      title: "Not found",
      type: "about:blank",
    }),
  );
};

export const startOrganizationCliServer = (handler: Parameters<typeof startCliServer>[0]) =>
  startCliServer((request, response) => {
    if (request.url === "/v1/auth/status") {
      sendEnvelope(response, {
        authenticated: true,
        user: { id: "user-1", email: "owner@example.com" },
        defaultOrganizationId: "org-1",
        sessionExpiresAt: "2026-07-12T12:00:00.000Z",
      });
      return;
    }
    if (request.url === "/v1/organizations/org-1") {
      sendEnvelope(response, {
        organization: {
          organizationId: "org-1",
          name: "Team",
          billingEmail: "owner@example.com",
          state: "active",
          createdByUserId: "user-1",
          createdAt: "2026-07-11T12:00:00.000Z",
          updatedAt: "2026-07-11T12:00:00.000Z",
        },
        membership: {
          organizationId: "org-1",
          membershipId: "membership-1",
          userId: "user-1",
          email: "owner@example.com",
          role: "owner",
          isDefault: true,
          joinedAt: "2026-07-11T12:00:00.000Z",
        },
      });
      return;
    }
    return handler(request, response);
  });
