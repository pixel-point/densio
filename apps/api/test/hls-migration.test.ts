import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-sqlite/migrator";
import { afterEach, expect, it } from "vitest";
import { migrateDatabase, openDatabase } from "../src/database/database.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("preserves existing storage objects through the HLS table rebuild and restores foreign-key enforcement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-hls-migration-"));
  roots.push(directory);
  const prior = join(directory, "prior");
  await mkdir(prior);
  const migrations = fileURLToPath(new URL("../drizzle", import.meta.url));
  for (const name of (await readdir(migrations)).filter(
    (candidate) => candidate < "20260904212433",
  )) {
    await mkdir(join(prior, name));
    await copyFile(join(migrations, name, "migration.sql"), join(prior, name, "migration.sql"));
  }
  const database = openDatabase(join(directory, "database.sqlite"));
  database.sqlite.exec("pragma foreign_keys = off");
  migrate(database.db, { migrationsFolder: prior });
  database.sqlite.exec("pragma foreign_keys = on");
  database.sqlite.exec(
    "insert into users (id, email, created_at, updated_at) values ('user-legacy','legacy@example.test',1,1)",
  );
  database.sqlite.exec(
    "insert into organizations (id,name,billing_email,state,created_by_user_id,created_at,updated_at) values ('org-legacy','Legacy','legacy@example.test','active','user-legacy',1,1)",
  );
  database.sqlite
    .prepare(
      "insert into storage_objects (id,organization_id,target_id,bucket_role,bucket,object_key,state,bytes,sha256,created_at) values (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "object-legacy",
      "org-legacy",
      "target",
      "staging",
      "staging",
      "source.bin",
      "verified",
      123,
      "b".repeat(64),
      1,
    );
  const before = database.sqlite.prepare("select * from storage_objects").get();
  migrateDatabase(database);
  expect(database.sqlite.prepare("select * from storage_objects").all()).toEqual([
    { ...before, package_member_id: null },
  ]);
  expect(database.sqlite.prepare("pragma foreign_key_check").all()).toEqual([]);
  expect(database.sqlite.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(
    database.sqlite.prepare("select count(*) as count from video_package_members").get(),
  ).toEqual({ count: 0 });
  database.close();
});
