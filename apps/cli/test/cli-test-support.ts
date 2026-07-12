import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const temporaryCliDirectories: Array<string> = [];

export const makeCliCapture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-cli-"));
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
