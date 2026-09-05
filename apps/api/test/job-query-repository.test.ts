import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  InvalidJobListCursor,
  listOwnedJobs,
  lookupOwnedJob,
} from "../src/database/job-query-repository.ts";
import { jobs, users } from "../src/database/schema.ts";

import { seedJobInput } from "./job-fixture.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("exposes owner-scoped job discovery operations", async () => {
  await expect(import("../src/database/job-query-repository.ts")).resolves.toMatchObject({
    listOwnedJobs: expect.any(Function),
    lookupOwnedJob: expect.any(Function),
  });
});

it("orders by creation and id with an opaque keyset cursor", async () => {
  const database = await createTestDatabase();
  seedJob(database, { createdAt: 30, id: "job-c", organizationId: "org-1" });
  seedJob(database, { createdAt: 30, id: "job-b", organizationId: "org-1" });
  seedJob(database, { createdAt: 20, id: "job-a", organizationId: "org-1" });

  const first = await Effect.runPromise(
    listOwnedJobs(database, { limit: 2, organizationId: "org-1" }),
  );
  expect(first.jobs.map(({ id }) => id)).toEqual(["job-c", "job-b"]);
  expect(first.nextCursor).toEqual(expect.any(String));
  if (first.nextCursor === undefined) throw new Error("Expected another page");

  const second = await Effect.runPromise(
    listOwnedJobs(database, { cursor: first.nextCursor, limit: 2, organizationId: "org-1" }),
  );
  expect(second.jobs.map(({ id }) => id)).toEqual(["job-a"]);
  expect(second.nextCursor).toBeUndefined();
  database.close();
});

it("combines owner, state, workflow, time, and correlation filters", async () => {
  const database = await createTestDatabase();
  seedJob(database, {
    clientReference: "asset-one",
    createdAt: 30,
    id: "matching",
    idempotencyKey: "request-one",
    state: "processing",
    organizationId: "org-1",
    workflow: "compress",
  });
  seedJob(database, {
    clientReference: "asset-one",
    createdAt: 30,
    id: "foreign",
    idempotencyKey: "request-one",
    state: "processing",
    organizationId: "org-2",
    workflow: "compress",
  });
  seedJob(database, { createdAt: 10, id: "too-old", organizationId: "org-1" });

  const result = await Effect.runPromise(
    listOwnedJobs(database, {
      clientReference: "asset-one",
      idempotencyKey: "request-one",
      limit: 100,
      since: 20,
      state: "processing",
      organizationId: "org-1",
      workflow: "compress",
    }),
  );

  expect(result.jobs.map(({ id }) => id)).toEqual(["matching"]);
  database.close();
});

it("looks up exactly one owner-scoped recovery selector", async () => {
  const database = await createTestDatabase();
  seedJob(database, {
    clientReference: "asset-one",
    createdAt: 30,
    id: "owned",
    idempotencyKey: "request-one",
    organizationId: "org-1",
  });

  await expect(
    Effect.runPromise(
      lookupOwnedJob(database, { clientReference: "asset-one", organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({ id: "owned" });
  await expect(
    Effect.runPromise(
      lookupOwnedJob(database, { idempotencyKey: "request-one", organizationId: "org-2" }),
    ),
  ).resolves.toBeUndefined();
  database.close();
});

it("rejects a malformed opaque cursor", async () => {
  const database = await createTestDatabase();

  await expect(
    Effect.runPromise(
      Effect.flip(
        listOwnedJobs(database, { cursor: "not-a-cursor", limit: 10, organizationId: "org-1" }),
      ),
    ),
  ).resolves.toBeInstanceOf(InvalidJobListCursor);
  database.close();
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-job-query-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  migrateDatabase(database);
  database.db
    .insert(users)
    .values([
      { createdAt: 1, email: "owner@example.com", id: "org-1", updatedAt: 1 },
      { createdAt: 1, email: "other@example.com", id: "org-2", updatedAt: 1 },
    ])
    .run();
  return database;
};

const seedJob = (
  database: Database,
  input: {
    readonly clientReference?: string;
    readonly createdAt: number;
    readonly id: string;
    readonly idempotencyKey?: string;
    readonly state?: typeof jobs.$inferInsert.state;
    readonly organizationId: string;
    readonly workflow?: typeof jobs.$inferInsert.kind;
  },
) =>
  database.db
    .insert(jobs)
    .values(
      seedJobInput(database, {
        ...(input.clientReference === undefined ? {} : { clientReference: input.clientReference }),
        createdAt: input.createdAt,
        id: input.id,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        kind: input.workflow ?? "compress",
        state: input.state ?? "queued",
        updatedAt: input.createdAt,
        organizationId: input.organizationId,
      }),
    )
    .run();
