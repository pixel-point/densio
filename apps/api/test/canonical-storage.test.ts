import { getTableColumns } from "drizzle-orm";
import { expect, it } from "vitest";
import { artifacts, executionPlans, jobs, preparedSources } from "../src/database/schema.ts";

it("stores one plan snapshot, one progress snapshot, and no duplicate lifecycle or access state", () => {
  expect(Object.keys(getTableColumns(executionPlans))).toEqual([
    "id",
    "createdByUserId",
    "organizationId",
    "sourceId",
    "snapshotJson",
    "supersedesPlanId",
    "requestDigest",
    "idempotencyKey",
    "createdAt",
    "expiresAt",
  ]);
  const job = getTableColumns(jobs);
  expect(job.sourceId.notNull).toBe(true);
  expect(job.executionPlanId.notNull).toBe(true);
  expect(job.progressJson.notNull).toBe(true);
  expect(job.revision).toBeDefined();
  for (const field of [
    "progress",
    "progressPhase",
    "progressRevision",
    "uploadState",
    "inputMode",
    "optionsJson",
    "policyVersion",
    "profileVersion",
  ]) {
    expect(job).not.toHaveProperty(field);
  }
  expect(getTableColumns(preparedSources)).not.toHaveProperty("uploadState");
  const artifact = getTableColumns(artifacts);
  expect(artifact.retainedUntil.notNull).toBe(true);
  expect(artifact).not.toHaveProperty("accessTokenHash");
  expect(artifact).not.toHaveProperty("expiresAt");
});
