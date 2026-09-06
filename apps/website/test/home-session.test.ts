import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import Home from "@/app/(website)/page";

const jar = vi.hoisted(() => new Map<string, { value: string }>());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.get(name) }),
}));
vi.mock("@/components/pages/home/hero", () => ({ Hero: () => null }));
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  jar.clear();
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

async function serveSession(authenticated: boolean) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        schemaVersion: 1,
        correlationId: "test",
        data: authenticated
          ? {
              authenticated: true,
              user: { id: "user", email: "user@densio.test" },
              defaultOrganizationId: "org",
              sessionExpiresAt: "2030-01-01T00:00:00.000Z",
            }
          : { authenticated: false },
      }),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  vi.stubEnv("DENSIO_API_URL", `http://127.0.0.1:${address.port}`);
  jar.set("densio_session", { value: "test-session" });
}

it("redirects a verified session to the dashboard resolver before rendering the homepage", async () => {
  await serveSession(true);
  await expect(Promise.resolve().then(() => Home())).rejects.toMatchObject({
    digest: "NEXT_REDIRECT;replace;/app;307;",
  });
});

it("renders the homepage for an anonymous visitor without requesting the API", async () => {
  vi.stubEnv("DENSIO_API_URL", "invalid-url-must-not-be-requested");
  expect((await Home()).type).toBe("main");
});

it("does not redirect a revoked session just because a cookie remains", async () => {
  await serveSession(false);
  expect((await Home()).type).toBe("main");
});
