import { afterEach, expect, it } from "vitest";
import { createJobTestContext, cleanupJobFixtures } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("migrates a fresh database to one canonical control-plane representation", async () => {
  const { database } = await createJobTestContext();
  const columns = (table: string) =>
    database.sqlite.prepare(`pragma table_info(${table})`).all() as Array<{
      readonly name: string;
      readonly notnull: number;
    }>;
  const names = (table: string) => columns(table).map(({ name }) => name);
  expect(names("prepared_sources")).toEqual(
    expect.arrayContaining(["request_digest", "state", "deleted_at", "cleaned_at"]),
  );
  expect(names("prepared_sources")).not.toContain("upload_state");
  expect(names("execution_plans").toSorted()).toEqual(
    [
      "id",
      "organization_id",
      "created_by_user_id",
      "source_id",
      "snapshot_json",
      "supersedes_plan_id",
      "request_digest",
      "idempotency_key",
      "created_at",
      "expires_at",
    ].toSorted(),
  );
  expect(names("jobs")).toEqual(
    expect.arrayContaining([
      "source_id",
      "execution_plan_id",
      "request_digest",
      "intent_digest",
      "quote_credit_units",
      "revision",
      "progress_json",
      "receipt_json",
      "workspace_cleaned_at",
    ]),
  );
  for (const retired of [
    "input_mode",
    "prepared_source_id",
    "upload_state",
    "options_json",
    "progress",
    "progress_phase",
    "progress_revision",
    "decision_json",
    "policy_version",
    "profile_version",
    "organization_cleaned_at",
  ]) {
    expect(names("jobs"), retired).not.toContain(retired);
  }
  expect(columns("artifacts").find(({ name }) => name === "retained_until")?.notnull).toBe(1);
  expect(names("artifacts")).not.toContain("expires_at");
  expect(names("artifacts")).not.toContain("access_token_hash");
  expect(names("artifact_access_grants")).toEqual(
    expect.arrayContaining(["artifact_id", "token_hash", "expires_at"]),
  );
  expect(names("job_events")).not.toContain("output_json");
  expect(names("job_write_activities")).toEqual(
    expect.arrayContaining(["job_id", "process_id", "process_identity"]),
  );
  expect(database.sqlite.prepare("pragma foreign_key_check").all()).toEqual([]);
});
