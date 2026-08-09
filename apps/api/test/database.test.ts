import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../src/database/database.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("database", () => {
  it("opens a migrated SQLite database with production safety pragmas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "densio-database-"));
    temporaryDirectories.push(directory);

    const database = openDatabase(join(directory, "database.sqlite"));
    migrateDatabase(database);

    expect(database.sqlite.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.sqlite.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(database.sqlite.prepare("pragma busy_timeout").get()).toEqual({ timeout: 5_000 });

    const rows = database.sqlite
      .prepare("select name from sqlite_schema where type = 'table' order by name")
      .all() as Array<{ readonly name: string }>;

    expect(rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["artifacts", "auth_challenges", "jobs", "sessions", "users"]),
    );

    database.close();
  });
});
