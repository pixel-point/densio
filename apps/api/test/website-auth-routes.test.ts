import {
  BrowserAuthPollResponseSchema,
  AuthStartResponseSchema,
  AuthStatusSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { loadConfig } from "../src/config.ts";
import { migrateDatabase, openDatabase } from "../src/database/database.ts";
import { authChallenges, emailOutbox } from "../src/database/schema.ts";
import { decodeEmailOutboxPayload } from "../src/email/email-outbox-payload.ts";
import { createAuthRoutes } from "../src/routes/auth.ts";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
const key = "0123456789abcdef".repeat(4);
const decodeStart = Schema.decodeUnknownSync(successEnvelope(AuthStartResponseSchema));
const decodeBrowser = Schema.decodeUnknownSync(successEnvelope(BrowserAuthPollResponseSchema));
const decodeStatus = Schema.decodeUnknownSync(successEnvelope(AuthStatusSchema));

const setup = async () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const config = loadConfig({
    PUBLIC_BASE_URL: "https://api.example.test",
    WEBSITE_BASE_URL: "https://www.example.test",
  });
  const clock = { now: Date.UTC(2026, 8, 5) };
  const authService = makeAuthService(database, makeMagicLinkSealer(key));
  const app = createAuthRoutes({
    authConfig: config.auth,
    authService,
    now: () => clock.now,
    createCorrelationId: () => "website-test",
    pollAfterSeconds: 2,
    requestIpHash: () => "test-ip",
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const login = decodeStart(
    await (await post("/v1/auth/login", { email: "user@example.test" })).json(),
  ).data;
  const email = database.db.select().from(emailOutbox).get();
  if (!email) throw new Error("Expected queued email");
  const payload = decodeEmailOutboxPayload(email.payloadJson);
  if (payload.kind !== "magic-login") throw new Error("Expected login email");
  const link = new URL(
    makeMagicLinkOpener(key)(payload.encryptedConfirmationUrl, {
      challengeId: payload.challengeId,
      emailId: email.id,
      recipient: email.recipient,
    }),
  );
  return {
    database,
    config,
    clock,
    authService,
    app,
    post,
    login,
    link,
    token: link.searchParams.get("token"),
  };
};

it("sends a website link and redirects the old API link without consuming it", async () => {
  const f = await setup();
  expect(f.link.origin).toBe("https://www.example.test");
  expect(f.link.pathname).toBe("/auth/confirm");
  const response = await f.app.request(`/v1/auth/confirm?token=${f.token}`);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(f.link.toString());
  expect(f.database.db.select().from(authChallenges).get()?.status).toBe("pending");
});

it("confirms with JSON and issues an API-owned browser session with absolute expiry", async () => {
  const f = await setup();
  const pending = await f.post("/v1/auth/browser/poll", { pollToken: f.login.pollToken });
  expect(pending.status).toBe(200);
  expect(await pending.json()).toMatchObject({ data: { status: "pending" } });
  const confirmation = await f.post("/v1/auth/confirm", { token: f.token });
  expect(confirmation.status).toBe(200);
  expect(await confirmation.json()).toMatchObject({ data: { status: "confirmed" } });
  const response = await f.post("/v1/auth/browser/poll", { pollToken: f.login.pollToken });
  expect(response.status).toBe(200);
  const body = decodeBrowser(await response.json());
  if (body.data.status !== "confirmed") throw new Error("Expected browser session");
  expect(body.data).toMatchObject({
    status: "confirmed",
    sessionToken: expect.any(String),
    expiresAt: new Date(f.clock.now + f.config.auth.refreshTokenTtlMs).toISOString(),
  });
  expect(body.data).not.toHaveProperty("refreshToken");
  const sessionToken = body.data.sessionToken;
  f.clock.now += f.config.auth.accessTokenTtlMs + 1;
  const status = await f.app.request("/v1/auth/status", {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  expect(decodeStatus(await status.json()).data).toMatchObject({
    authenticated: true,
    user: { email: "user@example.test" },
  });
  expect((await f.post("/v1/auth/browser/poll", { pollToken: f.login.pollToken })).status).toBe(
    409,
  );
  f.clock.now += f.config.auth.refreshTokenTtlMs;
  await expect(
    Effect.runPromise(f.authService.lookupAccess({ accessToken: sessionToken, now: f.clock.now })),
  ).rejects.toThrow();
});

it("revokes browser sessions through the normal logout API", async () => {
  const f = await setup();
  await f.post("/v1/auth/confirm", { token: f.token });
  const response = await f.post("/v1/auth/browser/poll", { pollToken: f.login.pollToken });
  expect(response.status).toBe(200);
  const body = decodeBrowser(await response.json());
  if (body.data.status !== "confirmed") throw new Error("Expected browser session");
  const headers = { authorization: `Bearer ${body.data.sessionToken}` };
  expect((await f.app.request("/v1/auth/logout", { method: "POST", headers })).status).toBe(200);
  expect((await f.app.request("/v1/auth/status", { headers })).status).toBe(401);
});

it("rejects malformed, expired, and previously used confirmations", async () => {
  const f = await setup();
  expect((await f.post("/v1/auth/confirm", {})).status).toBe(400);
  expect((await f.post("/v1/auth/confirm", { token: "invalid" })).status).toBe(400);
  f.clock.now += f.config.auth.challengeTtlMs;
  expect((await f.post("/v1/auth/confirm", { token: f.token })).status).toBe(410);
  const other = await setup();
  expect((await other.post("/v1/auth/confirm", { token: other.token })).status).toBe(200);
  expect((await other.post("/v1/auth/confirm", { token: other.token })).status).toBe(409);
});
