import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { AuthStatusSchema } from "@densio/shared";
import { afterEach, expect, it } from "vitest";
import { createDensioClient } from "@/lib/densio/client";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () =>
  Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  ),
);
const serve = async (handler: RequestListener) => {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
};

it("decodes shared API envelopes and sends credentials only in the authorization header", async () => {
  const requests: { url: string | undefined; authorization: string | undefined }[] = [];
  const url = await serve((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        schemaVersion: 1,
        correlationId: "test",
        data: { authenticated: false },
      }),
    );
  });
  const client = createDensioClient(url);
  expect(
    await client("/v1/auth/status", AuthStatusSchema, { token: "fixture-credential" }),
  ).toEqual({ ok: true, data: { authenticated: false } });
  expect(requests).toEqual([
    { url: "/v1/auth/status", authorization: "Bearer fixture-credential" },
  ]);
});

it("preserves actionable API problems without accepting malformed envelopes", async () => {
  const url = await serve((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/denied") {
      response.statusCode = 403;
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          type: "https://example.test/problems/denied",
          title: "Permission denied",
          status: 403,
          detail: "Ask an organization owner.",
          code: "ORGANIZATION_OWNER_REQUIRED",
          retryable: false,
          suggestedAction: "Contact the owner.",
          correlationId: "test",
        }),
      );
      return;
    }
    response.end(JSON.stringify({ data: { authenticated: false } }));
  });
  const client = createDensioClient(url);
  expect(await client("/v1/denied", AuthStatusSchema)).toMatchObject({
    ok: false,
    error: {
      status: 403,
      code: "ORGANIZATION_OWNER_REQUIRED",
      detail: "Ask an organization owner.",
    },
  });
  expect(await client("/v1/broken", AuthStatusSchema)).toMatchObject({
    ok: false,
    error: { code: "API_RESPONSE_INVALID" },
  });
});

it("does not follow redirects or expose raw transport errors", async () => {
  const url = await serve((_request, response) => {
    response.writeHead(302, { location: "https://example.test/never-contact" });
    response.end();
  });
  expect(await createDensioClient(url)("/v1/auth/status", AuthStatusSchema)).toMatchObject({
    ok: false,
    error: { code: "API_UNAVAILABLE" },
  });
});

it("bounds stalled API calls", async () => {
  const url = await serve(() => undefined);
  expect(await createDensioClient(url, 25)("/v1/auth/status", AuthStatusSchema)).toMatchObject({
    ok: false,
    error: { code: "API_UNAVAILABLE", retryable: true },
  });
});
