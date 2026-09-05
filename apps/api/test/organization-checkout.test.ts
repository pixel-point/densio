import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import type Stripe from "stripe";
import { makeBillingService } from "../src/billing/billing-service.ts";
import { StripeGatewayError } from "../src/billing/billing-errors.ts";
import type {
  StripeGatewayDefinition,
  StripeCheckoutState,
} from "../src/billing/stripe-gateway.ts";
import { transferOrganizationOwnership } from "../src/database/organization-repository.ts";
import { billingCheckoutAttempts, stripeSubscriptions } from "../src/database/schema.ts";
import { runAdminCommand } from "../src/admin/admin-command.ts";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const config = {
  checkoutCancelUrl: "https://densio.test/cancel",
  checkoutSuccessUrl: "https://densio.test/success",
  portalReturnUrl: "https://densio.test/billing",
  priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
  webhookSecret: "local-only",
};
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  const checkouts: Stripe.Checkout.SessionCreateParams[] = [];
  const customers: Stripe.CustomerCreateParams[] = [];
  const sessions = new Map<string, StripeCheckoutState>();
  const state = {
    loseResponse: false,
    failSubscription: false,
    subscriptionReads: 0,
    failContact: false,
    failPortal: false,
    customerEmail: "owner@example.test",
    now: organizationNow,
  };
  const gateway: StripeGatewayDefinition = {
    listCustomerSubscriptions: () => Effect.die("Unexpected subscription listing"),
    createCustomer: (params) =>
      Effect.sync(() => {
        customers.push(params);
        return "cus_team";
      }),
    findCustomer: () => Effect.succeed(customers.length === 0 ? null : "cus_team"),
    retrieveCustomer: (customerId) =>
      Effect.succeed({
        customerId,
        organizationId: fixture.organizationId,
        email: state.customerEmail,
      }),
    updateCustomer: (_customerId, email) =>
      Effect.gen(function* () {
        if (state.failContact)
          return yield* new StripeGatewayError({
            operation: "update-customer",
            cause: new Error("outage"),
          });
        state.customerEmail = email;
      }),
    createCheckoutSession: (params) =>
      Effect.gen(function* () {
        checkouts.push(params);
        const session = checkoutSession(fixture.organizationId, String(params.metadata?.attemptId));
        sessions.set(session.id, session);
        if (state.loseResponse)
          return yield* new StripeGatewayError({
            operation: "create-checkout-session",
            cause: new Error("lost response"),
          });
        return session;
      }),
    findCheckoutSession: (_customerId, attemptId) =>
      Effect.succeed(
        [...sessions.values()].find((session) => session.attemptId === attemptId) ?? null,
      ),
    retrieveCheckoutSession: (id) =>
      Effect.sync(() => {
        const session = sessions.get(id);
        if (session === undefined) throw new Error("Missing test session");
        return session;
      }),
    createPortalSession: () =>
      state.failPortal
        ? Effect.fail(
            new StripeGatewayError({ operation: "create-portal", cause: new Error("outage") }),
          )
        : Effect.succeed({ id: "bps_team", url: "https://billing.stripe.test/secret" }),
    retrieveSubscription: (subscriptionId) =>
      Effect.gen(function* () {
        state.subscriptionReads += 1;
        if (state.failSubscription)
          return yield* new StripeGatewayError({
            operation: "retrieve-subscription",
            cause: new Error("temporary outage"),
          });
        return {
          subscriptionId,
          customerId: "cus_team",
          organizationId: fixture.organizationId,
          status: "active",
          priceId: "price_basic",
          cancelAtPeriodEnd: false,
          currentPeriodEnd: organizationNow + 86_400_000,
        };
      }),
    parseWebhook: () => Effect.die("Unexpected webhook"),
  };
  const service = makeBillingService(fixture.database, gateway, () => state.now);
  const input = {
    actor: {
      organizationId: fixture.organizationId,
      userId: "owner",
      membershipId: fixture.team.membership.id,
    },
    config,
    plan: "basic" as const,
    idempotencyKey: "checkout-key",
    correlationId: "checkout-test",
  };
  return { ...fixture, checkouts, customers, sessions, state, service, input, gateway };
};

const checkoutSession = (organizationId: string, attemptId: string): StripeCheckoutState => ({
  id: "cs_team",
  url: "https://checkout.stripe.test/secret",
  status: "open",
  expiresAt: organizationNow + 1_800_000,
  customerId: "cus_team",
  subscriptionId: null,
  organizationId,
  attemptId,
});

it("rolls subscription evidence back when checkout completion cannot commit", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  const session = fixture.sessions.get("cs_team")!;
  fixture.sessions.set(session.id, {
    ...session,
    status: "complete",
    subscriptionId: "sub_paid",
    url: null,
  });
  fixture.database.sqlite.exec(
    "create trigger reject_checkout_completion before update on billing_checkout_attempts when NEW.state = 'complete' begin select raise(abort, 'retry commit'); end",
  );
  await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input)));
  expect(fixture.database.db.select().from(stripeSubscriptions).all()).toEqual([]);
  expect(fixture.database.db.select().from(billingCheckoutAttempts).get()?.state).toBe("open");
  fixture.database.sqlite.exec("drop trigger reject_checkout_completion");
  await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input)));
  expect(fixture.database.db.select().from(stripeSubscriptions).all()).toHaveLength(1);
  expect(fixture.database.db.select().from(billingCheckoutAttempts).get()?.state).toBe("complete");
});

it("operator recovery fails closed when provider checkout evidence is absent", async () => {
  const fixture = setup();
  fixture.state.loseResponse = true;
  await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input)));
  fixture.sessions.clear();
  fixture.state.now += 25 * 60 * 60_000;
  const dependencies = {
    grantedBy: "operator",
    now: () => fixture.state.now,
    gateway: fixture.gateway,
  };
  expect(
    await runAdminCommand(
      fixture.database,
      ["billing", "reconcile", fixture.organizationId],
      dependencies,
    ),
  ).toMatchObject({ exitCode: 4, error: { code: "ORGANIZATION_BILLING_BUSY" } });
  expect(fixture.checkouts).toHaveLength(1);
  expect(
    await runAdminCommand(
      fixture.database,
      ["billing", "inspect", fixture.organizationId],
      dependencies,
    ),
  ).toMatchObject({
    output: { pending: { operation: "checkout", idempotencyKey: fixture.input.idempotencyKey } },
  });
});

it("creates one organization customer and quantity-one subscription checkout across retries", async () => {
  const fixture = setup();
  const first = await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  const replay = await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  expect(replay).toEqual(first);
  expect(fixture.customers).toEqual([
    { email: "owner@example.test", metadata: { organizationId: fixture.organizationId } },
  ]);
  expect(fixture.checkouts).toHaveLength(1);
  expect(fixture.checkouts[0]).toMatchObject({
    customer: "cus_team",
    client_reference_id: fixture.organizationId,
    line_items: [{ price: "price_basic", quantity: 1 }],
    metadata: { organizationId: fixture.organizationId },
    subscription_data: { metadata: { organizationId: fixture.organizationId } },
  });
  expect(first).toMatchObject({
    organizationId: fixture.organizationId,
    kind: "checkout",
    expiresAt: new Date(organizationNow + 1_800_000).toISOString(),
  });
});

it("reconciles a lost response without issuing a second checkout", async () => {
  const fixture = setup();
  fixture.state.loseResponse = true;
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input))),
  ).toBeInstanceOf(StripeGatewayError);
  fixture.state.loseResponse = false;
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  expect(fixture.checkouts).toHaveLength(1);
  expect(fixture.customers).toHaveLength(1);
});

it("keeps completed checkout reconciliation pending until subscription evidence commits", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  const session = fixture.sessions.get("cs_team")!;
  fixture.sessions.set(session.id, {
    ...session,
    status: "complete",
    subscriptionId: "sub_paid",
    url: null,
  });
  fixture.state.failSubscription = true;
  const next = { ...fixture.input, idempotencyKey: "next-checkout" };
  expect(await Effect.runPromise(Effect.flip(fixture.service.createCheckout(next)))).toBeInstanceOf(
    StripeGatewayError,
  );
  expect(
    fixture.database.db
      .select()
      .from(billingCheckoutAttempts)
      .all()
      .map(({ state }) => state),
  ).toEqual(["open"]);
  fixture.state.failSubscription = false;
  expect(await Effect.runPromise(Effect.flip(fixture.service.createCheckout(next)))).toMatchObject({
    code: "ORGANIZATION_BILLING_BUSY",
  });
  expect(fixture.checkouts).toHaveLength(1);
  expect(fixture.database.db.select().from(stripeSubscriptions).all()).toMatchObject([
    { subscriptionId: "sub_paid" },
  ]);
});

it("reconciles a completed checkout recovered after a lost create response", async () => {
  const fixture = setup();
  fixture.state.loseResponse = true;
  await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input)));
  const session = fixture.sessions.get("cs_team")!;
  fixture.sessions.set(session.id, {
    ...session,
    status: "complete",
    subscriptionId: "sub_paid",
    url: null,
  });
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input))),
  ).toMatchObject({ code: "ORGANIZATION_BILLING_BUSY" });
  expect(fixture.database.db.select().from(stripeSubscriptions).all()).toMatchObject([
    { subscriptionId: "sub_paid" },
  ]);
  expect(fixture.checkouts).toHaveLength(1);
});

it("rejects provider evidence from another customer or a replaced session", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  const session = fixture.sessions.get("cs_team");
  if (session === undefined) throw new Error("Missing session");
  fixture.sessions.set("cs_team", { ...session, customerId: "cus_other" });
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input))),
  ).toMatchObject({ code: "ORGANIZATION_BILLING_BUSY" });
  fixture.sessions.set("cs_team", { ...session, id: "cs_replaced" });
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input))),
  ).toMatchObject({ code: "ORGANIZATION_BILLING_BUSY" });
  expect(fixture.checkouts).toHaveLength(1);
});

it("checks current ownership before replay and keeps the checkout after ownership transfer", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  transferOrganizationOwnership(fixture.database, {
    actor: fixture.input.actor,
    userId: "admin",
    now: organizationNow,
    correlationId: "transfer",
  });
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input))),
  ).toMatchObject({ code: "ORGANIZATION_OWNER_REQUIRED" });
  await Effect.runPromise(
    fixture.service.createCheckout({
      ...fixture.input,
      actor: { ...fixture.input.actor, userId: "admin", membershipId: fixture.admin.id },
    }),
  );
  expect(fixture.checkouts).toHaveLength(1);
});

it("rejects changed intent and another live checkout without a provider write", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  expect(
    await Effect.runPromise(
      Effect.flip(fixture.service.createCheckout({ ...fixture.input, plan: "pro" })),
    ),
  ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(
    await Effect.runPromise(
      Effect.flip(
        fixture.service.createCheckout({ ...fixture.input, idempotencyKey: "second-key" }),
      ),
    ),
  ).toMatchObject({ code: "ORGANIZATION_BILLING_BUSY" });
  expect(fixture.checkouts).toHaveLength(1);
});

it("does not recreate an uncertain checkout after Stripe may have pruned the idempotency key", async () => {
  const fixture = setup();
  fixture.state.loseResponse = true;
  await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input)));
  fixture.sessions.clear();
  fixture.state.now += 25 * 60 * 60_000;
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input))),
  ).toMatchObject({ code: "ORGANIZATION_BILLING_BUSY" });
  expect(fixture.checkouts).toHaveLength(1);
});

it("restricts contact changes to the owner and does not invent a portal expiry", async () => {
  const fixture = setup();
  expect(
    await Effect.runPromise(
      Effect.flip(
        fixture.service.updateContact({
          actor: { ...fixture.input.actor, userId: "admin", membershipId: fixture.admin.id },
          billingEmail: "billing@example.test",
          correlationId: "contact",
        }),
      ),
    ),
  ).toMatchObject({ code: "ORGANIZATION_OWNER_REQUIRED" });
  await Effect.runPromise(
    fixture.service.updateContact({
      actor: fixture.input.actor,
      billingEmail: "billing@example.test",
      correlationId: "contact",
    }),
  );
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  expect(fixture.customers[0]?.email).toBe("billing@example.test");
  const portal = await Effect.runPromise(
    fixture.service.createPortal({ actor: fixture.input.actor, config, correlationId: "portal" }),
  );
  expect(portal).toEqual({
    organizationId: fixture.organizationId,
    kind: "portal",
    url: "https://billing.stripe.test/secret",
  });
});

it("recovers an unchanged billing contact after the provider idempotency window", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  const contact = {
    actor: fixture.input.actor,
    billingEmail: "finance@example.test",
    correlationId: "contact-recovery",
  };
  fixture.state.failContact = true;
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.updateContact(contact))),
  ).toBeInstanceOf(StripeGatewayError);
  fixture.state.now += 25 * 60 * 60_000;
  fixture.state.failContact = false;
  expect(await Effect.runPromise(fixture.service.updateContact(contact))).toMatchObject({
    billingEmail: contact.billingEmail,
  });
  expect(fixture.state.customerEmail).toBe(contact.billingEmail);
  await Effect.runPromise(
    fixture.service.createPortal({ actor: fixture.input.actor, config, correlationId: "portal" }),
  );
});

it("does not leave a durable financial lock after a portal-session failure", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  fixture.state.failPortal = true;
  await Effect.runPromise(
    Effect.flip(
      fixture.service.createPortal({ actor: fixture.input.actor, config, correlationId: "portal" }),
    ),
  );
  expect(
    await Effect.runPromise(
      fixture.service.updateContact({
        actor: fixture.input.actor,
        billingEmail: "new@example.test",
        correlationId: "contact",
      }),
    ),
  ).toMatchObject({ billingEmail: "new@example.test" });
});

it("lets an operator inspect and reconcile saved contact intent without the original owner", async () => {
  const fixture = setup();
  await Effect.runPromise(fixture.service.createCheckout(fixture.input));
  fixture.state.failContact = true;
  await Effect.runPromise(
    Effect.flip(
      fixture.service.updateContact({
        actor: fixture.input.actor,
        billingEmail: "finance@example.test",
        correlationId: "contact",
      }),
    ),
  );
  transferOrganizationOwnership(fixture.database, {
    actor: fixture.input.actor,
    userId: "admin",
    now: organizationNow,
    correlationId: "transfer",
  });
  fixture.state.failContact = false;
  fixture.state.now += 25 * 60 * 60_000;
  const dependencies = {
    grantedBy: "local-operator",
    now: () => fixture.state.now,
    gateway: fixture.gateway,
  };
  expect(
    await runAdminCommand(
      fixture.database,
      ["billing", "inspect", fixture.organizationId],
      dependencies,
    ),
  ).toMatchObject({
    exitCode: 0,
    output: { pending: { operation: "contact", billingEmail: "finance@example.test" } },
  });
  expect(
    await runAdminCommand(
      fixture.database,
      ["billing", "reconcile", fixture.organizationId],
      dependencies,
    ),
  ).toMatchObject({ exitCode: 0, output: { reconciled: true } });
  expect(fixture.state.customerEmail).toBe("finance@example.test");
});

it("operator reconciliation recovers provider evidence without creating a replacement checkout", async () => {
  const fixture = setup();
  fixture.state.loseResponse = true;
  await Effect.runPromise(Effect.flip(fixture.service.createCheckout(fixture.input)));
  fixture.state.now += 25 * 60 * 60_000;
  const dependencies = {
    grantedBy: "operator",
    now: () => fixture.state.now,
    gateway: fixture.gateway,
  };
  expect(
    await runAdminCommand(
      fixture.database,
      ["billing", "reconcile", fixture.organizationId],
      dependencies,
    ),
  ).toMatchObject({ exitCode: 0, output: { reconciled: true } });
  expect(fixture.database.db.select().from(billingCheckoutAttempts).get()?.sessionId).toBe(
    "cs_team",
  );
  expect(fixture.checkouts).toHaveLength(1);
});
