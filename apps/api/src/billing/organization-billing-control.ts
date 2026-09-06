import { billingReturnUrl } from "./billing-return-url.ts";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { appendOrganizationAudit } from "../database/organization-audit-repository.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { BillingCustomerNotFound } from "./billing-errors.ts";
import { findBillingAccount } from "./billing-repository.ts";
import {
  acquireBillingOperation,
  completeBillingOperation,
  releaseBillingOperation,
  yieldBillingOperation,
  type BillingOperation,
} from "./billing-operation-repository.ts";
import type { BillingConfig } from "./billing-service.ts";
import type { StripeGateway } from "./stripe-gateway.ts";
import { reconcileBillingContact } from "./billing-contact.ts";

export const makeOrganizationBillingControl = (
  database: Database,
  gateway: StripeGateway["Service"],
  now: () => number,
) => ({
  createPortal: makePortal(database, gateway, now),
  updateContact: makeContact(database, gateway, now),
});

const makePortal = (database: Database, gateway: StripeGateway["Service"], now: () => number) =>
  Effect.fn("Billing.createPortal")(function* (input: {
    actor: OrganizationActor;
    config: BillingConfig;
    correlationId: string;
  }) {
    const account = yield* authorizedAccount(database, input.actor);
    if (account.customerId === null)
      return yield* new BillingCustomerNotFound({ organizationId: input.actor.organizationId });
    const customerId = account.customerId;
    const returnUrl = billingReturnUrl(input.config.portalReturnUrl, input.actor.organizationId);
    const operation = yield* organizationStorage("acquire-portal", () =>
      acquireBillingOperation(database, {
        actor: input.actor,
        operation: "portal",
        requestKey: digest(returnUrl),
        now: now(),
      }),
    );
    return yield* Effect.gen(function* () {
      const session = yield* gateway.createPortalSession(
        { customer: customerId, return_url: returnUrl },
        `densio:portal:${operation.id}`,
      );
      yield* organizationStorage("record-portal", () =>
        finishHostedSession(database, { ...input, operation, sessionId: session.id, now: now() }),
      );
      yield* authorizedAccount(database, input.actor);
      return {
        organizationId: input.actor.organizationId,
        kind: "portal" as const,
        url: session.url,
      };
    }).pipe(
      Effect.ensuring(
        organizationStorage("release-portal", () =>
          releaseBillingOperation(database, operation),
        ).pipe(Effect.orDie),
      ),
    );
  });

const makeContact = (database: Database, gateway: StripeGateway["Service"], now: () => number) =>
  Effect.fn("Billing.updateContact")(function* (input: {
    actor: OrganizationActor;
    billingEmail: string;
    correlationId: string;
  }) {
    const account = yield* authorizedAccount(database, input.actor);
    const billingEmail = input.billingEmail.trim().toLowerCase();
    const operation = yield* organizationStorage("acquire-contact", () =>
      acquireBillingOperation(database, {
        actor: input.actor,
        operation: "contact",
        requestKey: billingEmail,
        now: now(),
      }),
    );
    return yield* Effect.gen(function* () {
      yield* reconcileBillingContact(database, gateway, {
        operation,
        customerId: account.customerId,
        actor: { kind: "user", userId: input.actor.userId },
        correlationId: input.correlationId,
        now: now(),
      });
      yield* authorizedAccount(database, input.actor);
      return { organizationId: input.actor.organizationId, billingEmail };
    }).pipe(
      Effect.ensuring(
        organizationStorage("yield-contact", () => yieldBillingOperation(database, operation)).pipe(
          Effect.orDie,
        ),
      ),
    );
  });

const authorizedAccount = (database: Database, actor: OrganizationActor) =>
  organizationStorage("authorize-billing-account", () => {
    authorizeOrganization(database.db, actor, "billing-write");
    const account = findBillingAccount(database, actor.organizationId);
    if (account === undefined)
      throw organizationFailure("ORGANIZATION_NOT_FOUND", "Organization not found.");
    return account;
  });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const finishHostedSession = (
  database: Database,
  input: {
    actor: OrganizationActor;
    operation: BillingOperation;
    sessionId: string;
    now: number;
    correlationId: string;
  },
) =>
  database.db.transaction(
    (transaction) => {
      completeBillingOperation(transaction, input.operation);
      appendOrganizationAudit(transaction, {
        organizationId: input.actor.organizationId,
        kind: "billing-portal-created",
        actor: { kind: "user", userId: input.actor.userId },
        targetId: input.sessionId,
        now: input.now,
        correlationId: input.correlationId,
      });
    },
    { behavior: "immediate" },
  );
