import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { GET, HEAD } from "@/app/(account)/auth/confirm/route";

const jar = vi.hoisted(
  () => new Map<string, { value: string; options: Record<string, unknown> }>(),
);
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.get(name),
    set: (name: string, value: string, options: Record<string, unknown>) =>
      jar.set(name, { value, options }),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers({ "x-forwarded-proto": "https" }),
}));
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
const expiresAt = "2030-01-01T00:00:00.000Z";
const serve = async (code?: string) => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.statusCode = code ? 400 : 200;
    response.end(
      JSON.stringify(
        code
          ? {
              type: "https://api.example.test/problems/auth",
              title: "Invalid sign-in",
              status: 400,
              code,
              detail: "Unable to sign in",
              retryable: false,
              schemaVersion: 1,
              correlationId: "test",
              suggestedAction: "Request a new link.",
            }
          : {
              ok: true,
              schemaVersion: 1,
              correlationId: "test",
              data:
                request.url === "/v1/auth/browser/confirm"
                  ? { status: "confirmed", sessionToken: "private-session", expiresAt }
                  : { status: "confirmed" },
            },
      ),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  vi.stubEnv("DENSIO_API_URL", `http://127.0.0.1:${address.port}`);
  return received;
};
const browserCookies = () => {
  jar.set("densio_login_challenge", { value: "browser-challenge", options: {} });
  jar.set("densio_login_poll", { value: "private-poll", options: {} });
  jar.set("densio_login_return", { value: "/app/org/settings/members", options: {} });
};
const request = (token = "browser-challenge.secret", headers?: HeadersInit) =>
  new Request(`https://densio.sh/auth/confirm?token=${encodeURIComponent(token)}`, { headers });

it("returns a cookie and an HTTP redirect without rendering an intermediate page", async () => {
  await serve();
  browserCookies();
  const response = await GET(request());
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/app/org/settings/members");
  expect(await response.text()).toBe("");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(jar.get("densio_session")).toMatchObject({
    value: "private-session",
    options: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      expires: new Date(expiresAt),
    },
  });
  expect(jar.has("densio_login_poll")).toBe(false);
});

it("confirms CLI links without claiming another browser challenge", async () => {
  const received = await serve();
  browserCookies();
  const response = await GET(request("cli-challenge.secret"));
  expect(response.headers.get("location")).toBe("/auth/result?status=confirmed");
  expect(jar.has("densio_session")).toBe(false);
  expect(jar.get("densio_login_poll")?.value).toBe("private-poll");
  expect(received).toEqual(["/v1/auth/confirm"]);
});

it("lets links opened in another browser confirm the originating session", async () => {
  await serve();
  const response = await GET(request());
  expect(response.headers.get("location")).toBe("/auth/result?status=confirmed");
  expect(jar.has("densio_session")).toBe(false);
});

it("does not consume tokens for HEAD or speculative prefetch requests", async () => {
  const received = await serve();
  browserCookies();
  expect((await HEAD()).status).toBe(204);
  for (const headers of [
    new Headers({ purpose: "prefetch" }),
    new Headers({ "sec-purpose": "prefetch;prerender" }),
    new Headers({ "next-router-prefetch": "1" }),
  ]) {
    expect((await GET(request("browser-challenge.secret", headers))).status).toBe(204);
  }
  expect(received).toEqual([]);
  expect(jar.has("densio_session")).toBe(false);
});

it("rejects incomplete links without exposing the token in the error redirect", async () => {
  const received = await serve();
  for (const token of ["", "x".repeat(257)]) {
    const response = await GET(request(token));
    expect(response.headers.get("location")).toBe("/auth/result?status=invalid");
  }
  expect(received).toEqual([]);
});

it("redirects expired links to a stable error page without creating a session", async () => {
  await serve("AUTH_CHALLENGE_EXPIRED");
  browserCookies();
  const response = await GET(request());
  expect(response.headers.get("location")).toBe("/auth/result?status=expired");
  expect(jar.has("densio_session")).toBe(false);
});

it("keeps untrusted return destinations on the website", async () => {
  await serve();
  browserCookies();
  jar.set("densio_login_return", { value: "https://attacker.example", options: {} });
  expect((await GET(request())).headers.get("location")).toBe("/app");
});

it("keeps redirects on the browser origin when Next sees an internal hostname", async () => {
  await serve();
  browserCookies();
  const response = await GET(
    new Request("http://localhost:3801/auth/confirm?token=browser-challenge.secret", {
      headers: { host: "densio.sh", "x-forwarded-host": "densio.sh" },
    }),
  );
  expect(response.headers.get("location")).toBe("/app/org/settings/members");
});
