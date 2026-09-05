import { ExecutionPlanSnapshotSchema } from "@densio/shared";
import { and, eq, gt } from "drizzle-orm";
import { Schema } from "effect";
import type { Database, DatabaseTransaction } from "./database.ts";
import { jobs, executionPlans, preparedSources } from "./schema.ts";
import {
  findEffectiveBillingEntitlement,
  type BillingPriceIds,
} from "../billing/billing-repository.ts";
import { monthlyCreditUnits } from "../billing/credit-units.ts";
import { creditPeriodTotals } from "./job-credit-ledger.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import type { OrganizationActor } from "../organizations/organization-access.ts";
import {
  ExecutionPlanEntitlementRejected,
  ExecutionPlanSourceUnavailable,
} from "../execution-plans/execution-plan-errors.ts";

export interface JobAdmissionPolicy {
  readonly actor: OrganizationActor;
  readonly now: number;
  readonly priceIds: BillingPriceIds;
}

export const resolveJobAdmission = (
  database: Database,
  transaction: DatabaseTransaction,
  values: typeof jobs.$inferInsert,
  policy: JobAdmissionPolicy,
  pendingSnapshot?: typeof executionPlans.$inferInsert,
) => {
  const source = transaction
    .select()
    .from(preparedSources)
    .where(
      and(
        eq(preparedSources.id, values.sourceId),
        eq(preparedSources.organizationId, values.organizationId),
        eq(preparedSources.state, "ready"),
        gt(preparedSources.expiresAt, policy.now),
      ),
    )
    .get();
  const plan =
    pendingSnapshot ??
    transaction
      .select()
      .from(executionPlans)
      .where(
        and(
          eq(executionPlans.id, values.executionPlanId),
          eq(executionPlans.organizationId, values.organizationId),
          eq(executionPlans.sourceId, values.sourceId),
          gt(executionPlans.expiresAt, policy.now),
        ),
      )
      .get();
  if (
    source === undefined ||
    plan === undefined ||
    plan.id !== values.executionPlanId ||
    plan.organizationId !== values.organizationId ||
    plan.sourceId !== values.sourceId ||
    plan.expiresAt <= policy.now
  )
    throw new ExecutionPlanSourceUnavailable();
  const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionPlanSnapshotSchema))(
    plan.snapshotJson,
  );
  if (
    snapshot.state !== "ready" ||
    snapshot.intentDigest !== values.intentDigest ||
    snapshot.quote.creditUnits !== values.quoteCreditUnits
  )
    throw new Error("Job admission requires the persisted exact ready plan.");
  const entitlement = findEffectiveBillingEntitlement(database, {
    organizationId: values.organizationId,
    now: policy.now,
    priceIds: policy.priceIds,
  });
  if (entitlement === undefined)
    throw organizationFailure("ORGANIZATION_NOT_FOUND", "Organization not found.");
  const durationSeconds = snapshot.source.inspection.durationSeconds;
  if (durationSeconds > entitlement.entitlements.maxVideoDurationSeconds)
    throw new ExecutionPlanEntitlementRejected({
      reason: "duration",
      durationSeconds,
      limitSeconds: entitlement.entitlements.maxVideoDurationSeconds,
      plan: entitlement.entitlements.plan,
    });
  const codec = snapshot.expectedArtifacts
    .flatMap((artifact) => ("codec" in artifact ? [artifact.codec] : []))
    .find(
      (candidate) =>
        candidate !== undefined && !entitlement.entitlements.allowedCodecs.includes(candidate),
    );
  if (codec !== undefined)
    throw new ExecutionPlanEntitlementRejected({
      reason: "codec",
      codec,
      plan: entitlement.entitlements.plan,
    });
  const date = new Date(policy.now);
  const periodStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const totals = creditPeriodTotals(transaction, values.organizationId, periodStart);
  return {
    entitlement,
    periodStart,
    availableUnits: Math.max(
      0,
      monthlyCreditUnits(entitlement.credits.monthly) - totals.reservedUnits - totals.usedUnits,
    ),
  };
};
