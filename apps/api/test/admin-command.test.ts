import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { runAdminCommand } from "../src/admin/admin-command.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { users } from "../src/database/schema.ts";

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

it("grants, lists, and revokes Pro by normalized email", async () => {
  const database = await createTestDatabase();

  await expect(
    runAdminCommand(database, ["pro", "grant", " Agent@Example.COM "], {
      grantedBy: "operator",
      now: () => NOW,
    }),
  ).resolves.toMatchObject({ exitCode: 0, output: { created: true, email: "agent@example.com" } });
  await expect(
    runAdminCommand(database, ["pro", "list"], { grantedBy: "operator", now: () => NOW }),
  ).resolves.toMatchObject({
    exitCode: 0,
    output: { grants: [{ email: "agent@example.com", grantedBy: "operator" }] },
  });
  await expect(
    runAdminCommand(database, ["pro", "revoke", "agent@example.com"], {
      grantedBy: "operator",
      now: () => NOW + 1,
    }),
  ).resolves.toMatchObject({ exitCode: 0, output: { revoked: 1 } });
});

it("returns agent-readable errors for invalid usage and missing accounts", async () => {
  const database = await createTestDatabase();

  await expect(
    runAdminCommand(database, ["pro", "grant", "missing@example.com"], {
      grantedBy: "operator",
      now: () => NOW,
    }),
  ).resolves.toMatchObject({ exitCode: 4, error: { code: "USER_NOT_FOUND" } });
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
  database.db
    .insert(users)
    .values({
      createdAt: NOW,
      email: "agent@example.com",
      id: "user-1",
      updatedAt: NOW,
    })
    .run();
  return database;
};
