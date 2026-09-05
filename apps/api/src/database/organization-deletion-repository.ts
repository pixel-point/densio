import { closeOrganizationStorage } from "../storage/storage-closure.ts";
import { and, count, eq, exists, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type { OrganizationDeletionReceipt } from "@densio/shared";
import type { Database, DatabaseTransaction } from "./database.ts";
import {
  artifacts,
  artifactAccessGrants,
  billingOperations,
  billingCheckoutAttempts,
  jobs,
  organizations,
  organizationMemberships,
  organizationInvitations,
  preparedSources,
  sourceWriteActivities,
  stripeSubscriptions,
} from "./schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";
import {
  completeBillingOperation,
  type BillingOperation,
} from "../billing/billing-operation-repository.ts";
import { appendOrganizationAudit } from "./organization-audit-repository.ts";
import { replaceMissingDefault } from "./organization-membership-repository.ts";

export const organizationDeletionBlockers = (
  db: Database["db"] | DatabaseTransaction,
  organizationId: string,
  operationId?: string,
) =>
  [
    {
      kind: "jobs",
      count:
        db
          .select({ count: count() })
          .from(jobs)
          .where(
            and(
              eq(jobs.organizationId, organizationId),
              notInArray(jobs.state, ["succeeded", "failed", "canceled"]),
            ),
          )
          .get()?.count ?? 0,
    },
    {
      kind: "uploads",
      count:
        db
          .select({ count: count() })
          .from(preparedSources)
          .where(
            and(
              eq(preparedSources.organizationId, organizationId),
              or(
                inArray(preparedSources.state, ["awaiting-upload", "finalizing", "inspecting"]),
                exists(
                  db
                    .select()
                    .from(sourceWriteActivities)
                    .where(eq(sourceWriteActivities.sourceId, preparedSources.id)),
                ),
              ),
            ),
          )
          .get()?.count ?? 0,
    },
    {
      kind: "subscriptions",
      count:
        db
          .select({ count: count() })
          .from(stripeSubscriptions)
          .where(
            and(
              eq(stripeSubscriptions.organizationId, organizationId),
              notInArray(stripeSubscriptions.status, ["canceled", "incomplete_expired"]),
            ),
          )
          .get()?.count ?? 0,
    },
    {
      kind: "checkouts",
      count:
        db
          .select({ count: count() })
          .from(billingCheckoutAttempts)
          .where(
            and(
              eq(billingCheckoutAttempts.organizationId, organizationId),
              inArray(billingCheckoutAttempts.state, ["creating", "open"]),
            ),
          )
          .get()?.count ?? 0,
    },
    {
      kind: "billing-operations",
      count:
        db
          .select({ count: count() })
          .from(billingOperations)
          .where(
            and(
              eq(billingOperations.organizationId, organizationId),
              operationId === undefined ? undefined : ne(billingOperations.id, operationId),
            ),
          )
          .get()?.count ?? 0,
    },
  ].filter((blocker) => blocker.count > 0);

export const requireNoDeletionBlockers = (
  blockers: ReturnType<typeof organizationDeletionBlockers>,
) => {
  if (blockers.length > 0)
    throw new OrganizationError({
      code: "ORGANIZATION_DELETION_BLOCKED",
      detail:
        "Finish or cancel active work, delete pending uploads, and close billing before deleting this organization.",
      details: { blockers },
    });
};

export const acceptOrganizationDeletion = (
  database: Database,
  input: {
    actor: OrganizationActor;
    operation: BillingOperation;
    now: number;
    correlationId: string;
  },
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input.actor, "organization-delete");
      requireNoDeletionBlockers(
        organizationDeletionBlockers(transaction, input.actor.organizationId, input.operation.id),
      );
      completeBillingOperation(transaction, input.operation);
      closeOrganizationStorage(transaction, input.actor.organizationId, input.now);
      const organization = transaction
        .update(organizations)
        .set({
          state: "deleting",
          deletionRequestedAt: input.now,
          updatedAt: input.now,
          cleanupError: null,
        })
        .where(eq(organizations.id, input.actor.organizationId))
        .returning()
        .get();
      appendOrganizationAudit(transaction, {
        organizationId: input.actor.organizationId,
        kind: "organization-deletion-requested",
        actor: { kind: "user", userId: input.actor.userId },
        targetId: input.actor.organizationId,
        now: input.now,
        correlationId: input.correlationId,
      });
      revokeInvitationsForClosure(transaction, input);
      transaction
        .delete(artifactAccessGrants)
        .where(
          inArray(
            artifactAccessGrants.artifactId,
            transaction
              .select({ id: artifacts.id })
              .from(artifacts)
              .where(eq(artifacts.organizationId, input.actor.organizationId)),
          ),
        )
        .run();
      transaction
        .update(preparedSources)
        .set({ state: "deleted", deletedAt: input.now, updatedAt: input.now, cleanedAt: null })
        .where(eq(preparedSources.organizationId, input.actor.organizationId))
        .run();
      transaction
        .update(artifacts)
        .set({
          deletedAt: sql`coalesce(${artifacts.deletedAt}, ${input.now})`,
          deletionError: "pending",
        })
        .where(eq(artifacts.organizationId, input.actor.organizationId))
        .run();
      transaction
        .update(jobs)
        .set({ workspaceCleanedAt: null })
        .where(eq(jobs.organizationId, input.actor.organizationId))
        .run();
      const defaults = transaction
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, input.actor.organizationId),
            eq(organizationMemberships.isDefault, true),
          ),
        )
        .all();
      defaults.forEach(({ userId }) =>
        replaceMissingDefault(transaction, {
          userId,
          now: input.now,
          correlationId: input.correlationId,
        }),
      );
      return organization;
    },
    { behavior: "immediate" },
  );

export const deletionReceipt = (
  organization: typeof organizations.$inferSelect,
  publicBaseUrl: string,
): OrganizationDeletionReceipt => {
  if (organization.deletionRequestedAt === null || organization.state === "active")
    throw new Error("No organization deletion was requested.");
  const common = {
    organizationId: organization.id,
    requestedAt: new Date(organization.deletionRequestedAt).toISOString(),
    statusUrl: new URL(`/v1/organizations/${organization.id}`, publicBaseUrl).toString(),
  };
  if (organization.state === "deleting") return { ...common, state: "deleting" };
  if (organization.deletedAt === null)
    throw new Error("Deleted organization has no completion timestamp.");
  return {
    ...common,
    state: "deleted",
    completedAt: new Date(organization.deletedAt).toISOString(),
  };
};

const revokeInvitationsForClosure = (
  transaction: DatabaseTransaction,
  input: { actor: OrganizationActor; now: number; correlationId: string },
) => {
  transaction
    .update(organizationInvitations)
    .set({ state: "revoked", updatedAt: input.now })
    .where(
      and(
        eq(organizationInvitations.organizationId, input.actor.organizationId),
        eq(organizationInvitations.state, "pending"),
      ),
    )
    .returning({ id: organizationInvitations.id })
    .all()
    .forEach(({ id }) =>
      appendOrganizationAudit(transaction, {
        organizationId: input.actor.organizationId,
        kind: "invitation-revoked",
        actor: { kind: "system", service: "organization-closure" },
        targetId: id,
        now: input.now,
        correlationId: input.correlationId,
      }),
    );
};
