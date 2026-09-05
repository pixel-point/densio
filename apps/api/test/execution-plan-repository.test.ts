import { fixtureOrganizationActor } from "./organization-fixture-identity.ts";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { preparedSources } from "../src/database/schema.ts";
import {
  createExecutionPlan,
  findOwnedExecutionPlan,
  findOwnedReadyPreparedSource,
} from "../src/execution-plans/execution-plan-repository.ts";
import { seedJobInput, createJobTestContext, cleanupJobFixtures } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("returns the original immutable snapshot for owner-scoped keyed retries", async () => {
  const { database } = await createJobTestContext();
  const job = seedJobInput(database);
  const fixture = findOwnedExecutionPlan(database, job.executionPlanId, job.organizationId);
  if (fixture === undefined) throw new Error("Missing fixture plan");
  const first = createExecutionPlan(
    database,
    {
      ...fixture,
      id: "plan-first",
      idempotencyKey: "create-key",
    },
    fixtureOrganizationActor,
    1,
  );
  const replay = createExecutionPlan(
    database,
    {
      ...fixture,
      id: "plan-second",
      idempotencyKey: "create-key",
    },
    fixtureOrganizationActor,
    1,
  );
  expect(first).toMatchObject({
    created: true,
    plan: { id: "plan-first", snapshotJson: fixture.snapshotJson },
  });
  expect(replay).toMatchObject({ created: false, plan: { id: "plan-first" } });
  expect(findOwnedExecutionPlan(database, "plan-first", "other")).toBeUndefined();
});

it("selects only ready, retained sources owned by the caller", async () => {
  const { database } = await createJobTestContext();
  const job = seedJobInput(database);
  database.db
    .update(preparedSources)
    .set({ expiresAt: 10_000 })
    .where(eq(preparedSources.id, job.sourceId))
    .run();
  expect(
    findOwnedReadyPreparedSource(database, job.sourceId, job.organizationId, 9999),
  ).toMatchObject({
    state: "ready",
  });
  expect(findOwnedReadyPreparedSource(database, job.sourceId, "other", 9999)).toBeUndefined();
  expect(
    findOwnedReadyPreparedSource(database, job.sourceId, job.organizationId, 10_000),
  ).toBeUndefined();
  database.db
    .update(preparedSources)
    .set({ state: "deleted", deletedAt: 5 })
    .where(eq(preparedSources.id, job.sourceId))
    .run();
  expect(
    findOwnedReadyPreparedSource(database, job.sourceId, job.organizationId, 9999),
  ).toBeUndefined();
});
