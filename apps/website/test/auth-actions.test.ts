import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { beginLogin, pollLogin, confirmLogin } from "@/app/(account)/auth/actions";

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
const serve = async (responses: Record<string, unknown>) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        schemaVersion: 1,
        correlationId: "test",
        data: responses[request.url ?? ""],
      }),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  vi.stubEnv("DENSIO_API_URL", `http://127.0.0.1:${address.port}`);
};
const expiresAt = "2030-01-01T00:00:00.000Z";

it("stores login credentials in secure cookies and returns only the waiting UI state", async () => {
  await serve({
    "/v1/auth/login": {
      challengeId: "challenge",
      pollToken: "private-poll-token",
      expiresAt,
      pollAfterSeconds: 2,
    },
  });
  const form = new FormData();
  form.set("email", "user@example.test");
  form.set("returnTo", "/app/org/settings/members");
  const result = await beginLogin({}, form);
  expect(result).toMatchObject({
    waiting: { email: "user@example.test", expiresAt, pollAfterSeconds: 2 },
  });
  expect(JSON.stringify(result)).not.toContain("private-poll-token");
  expect(jar.get("densio_login_poll")).toMatchObject({
    value: "private-poll-token",
    options: { httpOnly: true, secure: true, sameSite: "lax", path: "/" },
  });
});

it("exchanges the challenge for an opaque cookie without returning the session token", async () => {
  await serve({
    "/v1/auth/browser/poll": {
      status: "confirmed",
      sessionToken: "private-session-token",
      expiresAt,
    },
  });
  jar.set("densio_login_poll", { value: "poll", options: {} });
  jar.set("densio_login_return", { value: "/app/org/settings/billing", options: {} });
  const result = await pollLogin();
  expect(result).toEqual({ status: "confirmed", returnTo: "/app/org/settings/billing" });
  expect(jar.get("densio_session")).toMatchObject({
    value: "private-session-token",
    options: { httpOnly: true, expires: new Date(expiresAt) },
  });
  expect(jar.has("densio_login_poll")).toBe(false);
});

it("does not redeem an unrelated browser challenge when confirming a CLI email", async () => {
  await serve({ "/v1/auth/confirm": { status: "confirmed" } });
  jar.set("densio_login_challenge", { value: "website-challenge", options: {} });
  jar.set("densio_login_poll", { value: "website-poll", options: {} });
  const form = new FormData();
  form.set("token", "cli-challenge.secret");
  expect(await confirmLogin({}, form)).toMatchObject({ confirmed: true });
  expect(jar.has("densio_session")).toBe(false);
  expect(jar.get("densio_login_poll")?.value).toBe("website-poll");
});

it("finishes the original waiting tab after the confirmation tab has issued the session", async () => {
  await serve({
    "/v1/auth/status": {
      authenticated: true,
      user: { id: "user", email: "user@example.test" },
      defaultOrganizationId: "org",
      sessionExpiresAt: expiresAt,
    },
  });
  jar.set("densio_session", { value: "session-issued-in-another-tab", options: {} });
  expect(await pollLogin()).toEqual({ status: "confirmed", returnTo: "/app" });
});
