import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, openDatabase, type Database } from "../src/database/database.ts";

const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
const createDatabase = () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  return database;
};

describe("organization persistence", () => {
  it("requires organization ownership and retains actors independently of ownership", () => {
    const { sqlite } = createDatabase();
    for (const table of [
      "prepared_sources",
      "execution_plans",
      "jobs",
      "job_credit_entries",
      "stripe_customers",
      "stripe_subscriptions",
      "admin_grants",
    ]) {
      const columns = sqlite.prepare(`pragma table_info(${table})`).all();
      expect(
        columns.map((column) => column.name),
        table,
      ).toContain("organization_id");
      expect(
        columns.map((column) => column.name),
        table,
      ).not.toContain("user_id");
    }
    for (const table of ["prepared_sources", "execution_plans", "jobs"]) {
      const references = sqlite.prepare(`pragma foreign_key_list(${table})`).all();
      expect(references).toContainEqual(
        expect.objectContaining({
          from: "created_by_user_id",
          table: "users",
          on_delete: "NO ACTION",
        }),
      );
    }
  });

  it("enforces one owner, one default, and unique organization memberships", () => {
    const { sqlite } = createDatabase();
    expect(
      sqlite.prepare("select name from sqlite_schema where type = 'table'").all(),
    ).toContainEqual({ name: "organization_memberships" });
    sqlite.exec(
      "insert into users values ('u1','u1@example.test',1,1),('u2','u2@example.test',1,1)",
    );
    sqlite.exec(
      "insert into organizations (id,name,billing_email,state,created_by_user_id,created_at,updated_at) values ('o1','Team','u1@example.test','active','u1',1,1),('o2','Other','u2@example.test','active','u2',1,1)",
    );
    const insert = sqlite.prepare(
      "insert into organization_memberships (id,organization_id,user_id,role,is_default,joined_at) values (?,?,?,?,?,?)",
    );
    insert.run("m1", "o1", "u1", "owner", 1, 1);
    expect(() => insert.run("m2", "o1", "u2", "owner", 1, 1)).toThrow();
    expect(() => insert.run("m3", "o2", "u1", "member", 1, 1)).toThrow();
    expect(() => insert.run("m4", "o1", "u1", "member", 0, 1)).toThrow();
    expect(() => insert.run("m5", "o2", "u1", "member", 0, 1)).not.toThrow();
  });
});
