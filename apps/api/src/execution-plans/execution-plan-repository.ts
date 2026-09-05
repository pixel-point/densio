import { and, eq, gt } from "drizzle-orm";

import type { Database } from "../database/database.ts";
import { executionPlans, preparedSources } from "../database/schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { ExecutionPlanSourceUnavailable } from "./execution-plan-errors.ts";

export const createExecutionPlan = (
  database: Database,
  values: typeof executionPlans.$inferInsert,
  actor: OrganizationActor,
  now: number,
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, actor, "media-write");
      if (values.organizationId !== actor.organizationId || values.createdByUserId !== actor.userId)
        throw organizationFailure("ORGANIZATION_ACCESS_DENIED", "Plan actor mismatch.");
      const existing =
        values.idempotencyKey === null || values.idempotencyKey === undefined
          ? undefined
          : transaction
              .select()
              .from(executionPlans)
              .where(
                and(
                  eq(executionPlans.organizationId, values.organizationId),
                  eq(executionPlans.idempotencyKey, values.idempotencyKey),
                ),
              )
              .get();
      if (existing !== undefined) return { created: false as const, plan: existing };
      const source = transaction
        .select()
        .from(preparedSources)
        .where(
          and(
            eq(preparedSources.id, values.sourceId),
            eq(preparedSources.organizationId, actor.organizationId),
            eq(preparedSources.state, "ready"),
            gt(preparedSources.expiresAt, now),
          ),
        )
        .get();
      if (source === undefined) throw new ExecutionPlanSourceUnavailable();
      const plan = transaction.insert(executionPlans).values(values).returning().get();
      return { created: true as const, plan };
    },
    { behavior: "immediate" },
  );

export const findOwnedExecutionPlan = ({ db }: Database, planId: string, organizationId: string) =>
  db
    .select()
    .from(executionPlans)
    .where(and(eq(executionPlans.id, planId), eq(executionPlans.organizationId, organizationId)))
    .get();

export const findExecutionPlanByIdempotencyKey = (
  { db }: Database,
  organizationId: string,
  idempotencyKey: string,
) =>
  db
    .select()
    .from(executionPlans)
    .where(
      and(
        eq(executionPlans.organizationId, organizationId),
        eq(executionPlans.idempotencyKey, idempotencyKey),
      ),
    )
    .get();

export const findOwnedReadyPreparedSource = (
  { db }: Database,
  sourceId: string,
  organizationId: string,
  now: number,
) =>
  db
    .select()
    .from(preparedSources)
    .where(
      and(
        eq(preparedSources.id, sourceId),
        eq(preparedSources.organizationId, organizationId),
        eq(preparedSources.state, "ready"),
        gt(preparedSources.expiresAt, now),
      ),
    )
    .get();

export const findPreparedSourceSnapshot = ({ db }: Database, sourceId: string) =>
  db.select().from(preparedSources).where(eq(preparedSources.id, sourceId)).get();
