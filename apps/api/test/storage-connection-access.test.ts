import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { verifyConnectionAccess } from "../src/storage/connections/connection-store.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

test.each([
  [403, "", true],
  [404, "", true],
  [400, "<Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>", true],
  [400, "<Error><Code>InvalidArgument</Code><Message>Range</Message></Error>", false],
  [400, "x".repeat(2048), false],
  [200, "private-video", false],
  [206, "v", false],
  [500, "unavailable", false],
])(
  "private storage denial status %s is validated by its response",
  async (status, body, denied) => {
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/xml" });
      response.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const check = verifyConnectionAccess(`${endpoint}/staging/video.webm`, false, 13, {
      now: () => 0,
      activeCredentialKey: "test",
      credentialKeys: {},
      allowedOrigins: [endpoint],
    });
    if (denied) {
      await expect(check).resolves.toBeUndefined();
      return;
    }
    await expect(check).rejects.toMatchObject({ code: "STORAGE_PRIVATE_STAGING_REQUIRED" });
  },
);
