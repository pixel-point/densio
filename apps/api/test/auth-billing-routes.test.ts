import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthPollResponseSchema,
  AuthStartResponseSchema,
  AuthStatusSchema,
  AuthTokensSchema,
  BillingSessionResponseSchema,
  BillingStatusSchema,
  LogoutResponseSchema,
  ProblemDetailsSchema,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import Stripe from "stripe";
import { afterEach, expect, it } from "vitest";

import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { type BillingConfig, makeBillingService } from "../src/billing/billing-service.ts";
import {
  type BillingWebhookEvent,
  makeStripeGateway,
  StripeGateway,
} from "../src/billing/stripe-gateway.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  emailOutbox,
  stripeCustomers,
  stripeEvents,
  stripeSubscriptions,
  users,
} from "../src/database/schema.ts";
import { createAuthRoutes } from "../src/routes/auth.ts";
import { createBillingRoutes } from "../src/routes/billing.ts";

const NOW = 1_800_000_000_000;
const OUTBOX_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const openMagicLink = makeMagicLinkOpener(OUTBOX_ENCRYPTION_KEY);
const sealMagicLink = makeMagicLinkSealer(OUTBOX_ENCRYPTION_KEY);
const AUTH_CONFIG = {
  accessTokenTtlMs: 15 * 60_000,
  challengeTtlMs: 10 * 60_000,
  maxChallengesPerEmail: 5,
  maxChallengesPerIp: 5,
  publicBaseUrl: "https://media.example",
  rateLimitWindowMs: 60_000,
  refreshTokenTtlMs: 30 * 24 * 60 * 60_000,
};
const BILLING_CONFIG: BillingConfig = {
  checkoutCancelUrl: "https://app.example/billing/canceled",
  checkoutSuccessUrl: "https://app.example/billing/success",
  portalReturnUrl: "https://app.example/settings/billing",
  priceIds: {
    basic: "price_basic",
    premium: "price_premium",
    pro: "price_pro",
  },
  webhookSecret: "whsec_route_fixture",
};
const decodeAuthStart = Schema.decodeUnknownSync(successEnvelope(AuthStartResponseSchema));
const decodeAuthPoll = Schema.decodeUnknownSync(successEnvelope(AuthPollResponseSchema));
const decodeAuthStatus = Schema.decodeUnknownSync(successEnvelope(AuthStatusSchema));
const decodeAuthTokens = Schema.decodeUnknownSync(successEnvelope(AuthTokensSchema));
const decodeLogout = Schema.decodeUnknownSync(successEnvelope(LogoutResponseSchema));
const decodeBillingSession = Schema.decodeUnknownSync(
  successEnvelope(BillingSessionResponseSchema),
);
const decodeBillingStatus = Schema.decodeUnknownSync(successEnvelope(BillingStatusSchema));
const decodeProblem = Schema.decodeUnknownSync(ProblemDetailsSchema);

const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("completes the magic-link flow and reports authenticated ownership", async () => {
  const harness = await createRouteHarness();

  const anonymous = decodeAuthStatus(await (await harness.app.request("/v1/auth/status")).json());
  expect(anonymous.data).toEqual({ authenticated: false });

  const login = await requestLogin(harness.app);
  expect(login.response.status).toBe(202);
  expect(login.body.data).toMatchObject({
    challengeId: expect.any(String),
    pollAfterSeconds: 2,
  });
  expect(login.response.headers.get("x-correlation-id")).toBe("route-correlation");

  const pendingResponse = await harness.app.request("/v1/auth/poll", {
    body: JSON.stringify({ pollToken: login.body.data.pollToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(decodeAuthPoll(await pendingResponse.json()).data.status).toBe("pending");

  const confirmation = readConfirmationUrl(harness.database);
  const confirmedResponse = await harness.app.request(
    `${confirmation.pathname}${confirmation.search}`,
  );
  expect(confirmedResponse.status).toBe(200);
  expect(confirmedResponse.headers.get("content-type")).toContain("text/html");
  await expect(confirmedResponse.text()).resolves.toContain("Login confirmed");

  const pollResponse = await harness.app.request("/v1/auth/poll", {
    body: JSON.stringify({ pollToken: login.body.data.pollToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const polled = decodeAuthPoll(await pollResponse.json());
  if (polled.data.status !== "confirmed") throw new Error("Expected tokens");
  const statusResponse = await harness.app.request("/v1/auth/status", {
    headers: { authorization: `Bearer ${polled.data.accessToken}` },
  });
  const status = decodeAuthStatus(await statusResponse.json());

  expect(status.data).toMatchObject({
    authenticated: true,
    user: { email: "agent@example.com", plan: "free" },
  });
  expect(status.data.authenticated && status.data.user.id).toBe(
    harness.database.db.select().from(users).get()?.id,
  );
});

it("rotates tokens, logs out, and returns actionable auth problems", async () => {
  const harness = await createRouteHarness();
  const tokens = await completeLogin(harness);
  const refreshResponse = await harness.app.request("/v1/auth/refresh", {
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(refreshResponse.status).toBe(200);
  const refreshed = decodeAuthTokens(await refreshResponse.json());

  const oldStatus = await harness.app.request("/v1/auth/status", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  expect(oldStatus.status).toBe(401);

  const logoutResponse = await harness.app.request("/v1/auth/logout", {
    headers: { authorization: `Bearer ${refreshed.data.accessToken}` },
    method: "POST",
  });
  expect(logoutResponse.status).toBe(200);
  expect(decodeLogout(await logoutResponse.json()).data).toEqual({ revoked: true });

  const revokedStatus = await harness.app.request("/v1/auth/status", {
    headers: { authorization: `Bearer ${refreshed.data.accessToken}` },
  });
  expect(revokedStatus.status).toBe(401);
  expect(decodeProblem(await revokedStatus.json())).toMatchObject({
    code: "AUTH_REQUIRED",
    correlationId: "route-correlation",
    status: 401,
  });

  const invalidJson = await harness.app.request("/v1/auth/login", {
    body: "not-json",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(invalidJson.status).toBe(400);
  expect(decodeProblem(await invalidJson.json()).code).toBe("INVALID_REQUEST");
});

it("uses the authenticated user for Checkout, Portal, and billing status", async () => {
  const checkoutRequests: Array<Stripe.Checkout.SessionCreateParams> = [];
  const portalRequests: Array<Stripe.BillingPortal.SessionCreateParams> = [];
  const harness = await createRouteHarness(
    recordingStripeGateway(checkoutRequests, portalRequests),
  );
  const tokens = await completeLogin(harness);
  const user = harness.database.db.select().from(users).get();
  if (user === undefined) throw new Error("Missing user");

  const checkoutResponse = await harness.app.request("/v1/billing/checkout", {
    body: JSON.stringify({ plan: "basic" }),
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(checkoutResponse.status).toBe(201);
  expect(decodeBillingSession(await checkoutResponse.json()).data).toMatchObject({
    kind: "checkout",
    url: "https://checkout.stripe.test/session",
  });
  expect(checkoutRequests[0]).toMatchObject({
    client_reference_id: user.id,
    customer_email: "agent@example.com",
    metadata: { userId: user.id },
    line_items: [{ price: "price_basic", quantity: 1 }],
  });

  const malformedCheckout = await harness.app.request("/v1/billing/checkout", {
    body: "not-json",
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(malformedCheckout.status).toBe(400);
  expect(decodeProblem(await malformedCheckout.json()).code).toBe("INVALID_REQUEST");

  const oversizedCheckout = await harness.app.request("/v1/billing/checkout", {
    body: JSON.stringify({ padding: "x".repeat(70_000), plan: "basic" }),
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(oversizedCheckout.status).toBe(413);
  expect(decodeProblem(await oversizedCheckout.json()).code).toBe("REQUEST_TOO_LARGE");

  const missingPortal = await harness.app.request("/v1/billing/portal", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
    method: "POST",
  });
  expect(missingPortal.status).toBe(409);
  databaseCustomer(harness.database, user.id);
  const portalResponse = await harness.app.request("/v1/billing/portal", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
    method: "POST",
  });
  expect(portalResponse.status).toBe(201);
  expect(portalRequests).toEqual([
    {
      customer: "cus_agent",
      return_url: BILLING_CONFIG.portalReturnUrl,
    },
  ]);

  await Effect.runPromise(
    harness.billingService.grantPro({ grantedBy: "root", now: NOW, userId: user.id }),
  );
  const billingStatus = await harness.app.request("/v1/billing/status", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  expect(decodeBillingStatus(await billingStatus.json()).data).toEqual({
    credits: {
      available: 5_000,
      monthly: 5_000,
      reserved: 0,
      resetsAt: nextUtcMonth(NOW),
      used: 0,
    },
    entitlementSource: "admin",
    plan: "pro",
  });

  const unauthorized = await harness.app.request("/v1/billing/status");
  expect(unauthorized.status).toBe(401);
  expect(decodeProblem(await unauthorized.json()).code).toBe("AUTH_REQUIRED");
});

it("verifies the raw Stripe webhook body and exposes Stripe billing status", async () => {
  const stripe = new Stripe("sk_test_route_fixture");
  const harness = await createRouteHarness(
    StripeGateway.of({
      ...makeStripeGateway(stripe),
      retrieveSubscription: Effect.fn("RouteStripe.retrieveSubscription")(() =>
        Effect.succeed({
          cancelAtPeriodEnd: false,
          currentPeriodEnd: 1_900_000_000_000,
          customerId: "cus_agent",
          priceId: "price_premium",
          status: "active" as const,
          subscriptionId: "sub_agent",
          userId: null,
        }),
      ),
    }),
  );
  const tokens = await completeLogin(harness);
  const userId = harness.database.db.select().from(users).get()?.id;
  if (userId === undefined) throw new Error("Missing user");
  databaseCustomer(harness.database, userId);
  const payload = JSON.stringify(subscriptionEventFixture(userId));
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: BILLING_CONFIG.webhookSecret,
  });

  const webhookResponse = await harness.app.request("/v1/billing/webhook", {
    body: payload,
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    method: "POST",
  });
  expect(webhookResponse.status).toBe(200);
  expect(harness.database.db.select().from(stripeEvents).all()).toHaveLength(1);
  expect(harness.database.db.select().from(stripeSubscriptions).get()?.status).toBe("active");

  const statusResponse = await harness.app.request("/v1/billing/status", {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  expect(decodeBillingStatus(await statusResponse.json()).data).toEqual({
    credits: {
      available: 7_500,
      monthly: 7_500,
      reserved: 0,
      resetsAt: nextUtcMonth(NOW),
      used: 0,
    },
    entitlementSource: "stripe",
    plan: "premium",
    renewsAt: "2030-03-17T17:46:40.000Z",
    subscriptionStatus: "active",
  });

  const invalidResponse = await harness.app.request("/v1/billing/webhook", {
    body: payload,
    headers: { "stripe-signature": "invalid" },
    method: "POST",
  });
  expect(invalidResponse.status).toBe(400);
  expect(decodeProblem(await invalidResponse.json()).code).toBe("INVALID_STRIPE_WEBHOOK");
  expect(harness.database.db.select().from(stripeEvents).all()).toHaveLength(1);
});

it("rejects oversized JSON before buffering or decoding it", async () => {
  const harness = await createRouteHarness();
  const response = await harness.app.request("/v1/auth/login", {
    body: JSON.stringify({ email: "agent@example.com", padding: "x".repeat(70_000) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  expect(response.status).toBe(413);
  expect(decodeProblem(await response.json()).code).toBe("REQUEST_TOO_LARGE");
});

interface RouteHarness {
  readonly app: Hono;
  readonly billingService: ReturnType<typeof makeBillingService>;
  readonly database: Database;
}

const createRouteHarness = async (
  gateway = recordingStripeGateway([], []),
): Promise<RouteHarness> => {
  const database = await createTestDatabase();
  const authService = makeAuthService(database, sealMagicLink);
  const billingService = makeBillingService(database, gateway);
  const app = new Hono();
  const common = {
    authService,
    billingService,
    createCorrelationId: () => "route-correlation",
    now: () => NOW,
  };
  app.route(
    "/",
    createAuthRoutes({
      ...common,
      authConfig: AUTH_CONFIG,
      pollAfterSeconds: 2,
      priceIds: BILLING_CONFIG.priceIds,
      requestIpHash: () => "request-ip-hash",
    }),
  );
  app.route(
    "/",
    createBillingRoutes({
      ...common,
      billingConfig: BILLING_CONFIG,
      billingSessionTtlMs: 30 * 60_000,
    }),
  );
  return { app, billingService, database };
};

const completeLogin = async (harness: RouteHarness) => {
  const login = await requestLogin(harness.app);
  const confirmation = readConfirmationUrl(harness.database);
  await harness.app.request(`${confirmation.pathname}${confirmation.search}`);
  const response = await harness.app.request("/v1/auth/poll", {
    body: JSON.stringify({ pollToken: login.body.data.pollToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const envelope = decodeAuthPoll(await response.json());
  if (envelope.data.status !== "confirmed") throw new Error("Expected tokens");
  return envelope.data;
};

const requestLogin = async (app: Hono) => {
  const response = await app.request("/v1/auth/login", {
    body: JSON.stringify({ email: "agent@example.com" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return { body: decodeAuthStart(await response.clone().json()), response };
};

const readConfirmationUrl = (database: Database) => {
  const email = database.db.select().from(emailOutbox).get();
  if (email === undefined) throw new Error("Missing confirmation URL");
  return new URL(
    openMagicLink(email.encryptedConfirmationUrl ?? "", {
      challengeId: email.challengeId,
      emailId: email.id,
      recipient: email.recipient,
    }),
  );
};

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-route-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const recordingStripeGateway = (
  checkoutRequests: Array<Stripe.Checkout.SessionCreateParams>,
  portalRequests: Array<Stripe.BillingPortal.SessionCreateParams>,
) =>
  StripeGateway.of({
    createCheckoutSession: Effect.fn("RouteStripe.createCheckoutSession")((params) =>
      Effect.sync(() => {
        checkoutRequests.push(params);
        return {
          id: "cs_route",
          url: "https://checkout.stripe.test/session",
        };
      }),
    ),
    createPortalSession: Effect.fn("RouteStripe.createPortalSession")((params) =>
      Effect.sync(() => {
        portalRequests.push(params);
        return {
          id: "bps_route",
          url: "https://billing.stripe.test/session",
        };
      }),
    ),
    parseWebhook: Effect.fn("RouteStripe.parseWebhook")(() =>
      Effect.succeed<BillingWebhookEvent>({ eventId: "evt_ignored", kind: "ignored" }),
    ),
    retrieveSubscription: Effect.fn("RouteStripe.unusedRetrieveSubscription")(() =>
      Effect.die("Stripe subscription retrieval was not expected"),
    ),
  });

const databaseCustomer = (database: Database, userId: string) => {
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_agent", userId })
    .run();
};

const subscriptionEventFixture = (userId: string) => ({
  api_version: null,
  created: 1_800_000_000,
  data: {
    object: {
      cancel_at_period_end: false,
      customer: "cus_agent",
      id: "sub_agent",
      items: {
        data: [
          {
            current_period_end: 1_900_000_000,
            price: { id: "price_premium" },
          },
        ],
      },
      metadata: { userId },
      object: "subscription",
      status: "active",
    },
  },
  id: "evt_route_subscription",
  livemode: false,
  object: "event",
  pending_webhooks: 1,
  request: null,
  type: "customer.subscription.updated",
});

const nextUtcMonth = (now: number) => {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
};
