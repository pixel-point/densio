import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runAdminCommand } from "../src/admin/admin-command.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";

const NOW = 1_800_000_000_000;
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

it("grants, lists, and revokes Pro by organization ID", async () => {
  const database = await createTestDatabase();

  await expect(
    runAdminCommand(database, ["pro", "grant", "org-1"], {
      grantedBy: "operator",
      now: () => NOW,
    }),
  ).resolves.toMatchObject({ exitCode: 0, output: { created: true, organizationId: "org-1" } });
  await expect(
    runAdminCommand(database, ["pro", "list"], { grantedBy: "operator", now: () => NOW }),
  ).resolves.toMatchObject({
    exitCode: 0,
    output: { grants: [{ organizationId: "org-1", grantedBy: "operator" }] },
  });
  await expect(
    runAdminCommand(database, ["pro", "revoke", "org-1"], {
      grantedBy: "operator",
      now: () => NOW + 1,
    }),
  ).resolves.toMatchObject({ exitCode: 0, output: { revoked: 1 } });
});

it("returns agent-readable errors for invalid usage and missing accounts", async () => {
  const database = await createTestDatabase();

  await expect(
    runAdminCommand(database, ["pro", "grant", "missing-org"], {
      grantedBy: "operator",
      now: () => NOW,
    }),
  ).resolves.toMatchObject({ exitCode: 4, error: { code: "ORGANIZATION_NOT_FOUND" } });
  await expect(
    runAdminCommand(database, ["unknown"], { grantedBy: "operator", now: () => NOW }),
  ).resolves.toMatchObject({ exitCode: 2, error: { code: "INVALID_USAGE" } });
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-admin-command-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  ensureOrganizationActor(database);
  return database;
};
