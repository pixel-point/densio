import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

const migrationsFolder =
  process.env.DRIZZLE_MIGRATIONS_PATH ??
  [new URL("../../drizzle", import.meta.url), new URL("../drizzle", import.meta.url)]
    .map((url) => fileURLToPath(url))
    .find(existsSync) ??
  resolve("drizzle");

export const openDatabase = (path: string) => {
  const sqlite = new DatabaseSync(path);
  sqlite.exec("pragma foreign_keys = on");
  sqlite.exec("pragma journal_mode = wal");
  sqlite.exec("pragma busy_timeout = 5000");
  sqlite.exec("pragma synchronous = normal");

  return {
    close: () => sqlite.close(),
    db: drizzle({ client: sqlite }),
    sqlite,
  };
};

export type Database = ReturnType<typeof openDatabase>;
export type DatabaseTransaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

export const migrateDatabase = ({ db, sqlite }: Database) => {
  const tables = sqlite.prepare("select name from sqlite_schema where type = 'table'").all();
  if (
    tables.some((table) => table.name === "users") &&
    !tables.some((table) => table.name === "organizations")
  ) {
    if (sqlite.prepare("select 1 from users limit 1").get() !== undefined) {
      throw new Error(
        "Organization ownership requires a fresh database path. Existing development data was not changed.",
      );
    }
  }
  // SQLite ignores foreign_keys changes inside Drizzle's migration transaction.
  // Generated table rebuilds require it off before BEGIN, never during application work.
  sqlite.exec("pragma foreign_keys = off");
  try {
    migrate(db, { migrationsFolder });
    if (sqlite.prepare("pragma foreign_key_check").all().length !== 0) {
      throw new Error("Database migration failed foreign-key integrity verification.");
    }
  } finally {
    sqlite.exec("pragma foreign_keys = on");
  }
};
