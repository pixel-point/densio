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

export const migrateDatabase = ({ db }: Database) => {
  migrate(db, { migrationsFolder });
};
