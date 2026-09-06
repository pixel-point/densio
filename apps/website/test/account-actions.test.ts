import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { renameOrganization } from "@/app/(account)/app/actions";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "opaque-session" }) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`Redirect ${path}`);
  },
}));
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it("sends mutations to the URL organization and preserves the API's permission denial", async () => {
  const requests: { path: string; authorization?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(403, { "content-type": "application/problem+json" });
    response.end(
      JSON.stringify({
        schemaVersion: 1,
        type: "https://api.example.test/problems/organization-forbidden",
        status: 403,
        code: "ORGANIZATION_FORBIDDEN",
        title: "Permission denied",
        detail: "Only owners and admins may rename this organization.",
        retryable: false,
        correlationId: "test",
        suggestedAction: "Ask an administrator.",
      }),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected address");
  vi.stubEnv("DENSIO_API_URL", `http://127.0.0.1:${address.port}`);
  const form = new FormData();
  form.set("name", "New name");
  form.set("organizationId", "forged-hidden-field");
  expect(await renameOrganization("url-organization", {}, form)).toEqual({
    error: "Only owners and admins may rename this organization.",
  });
  expect(requests).toEqual([
    {
      path: "/v1/organizations/url-organization",
      authorization: "Bearer opaque-session",
      body: '{"name":"New name"}',
    },
  ]);
});
