import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { appendJobEvent, listOwnedJobEvents } from "../src/database/job-event-repository.ts";
import { jobEvents, jobs, users } from "../src/database/schema.ts";

import { seedJobInput } from "./job-fixture.ts";

const temporaryDirectories: Array<string> = [];
const progress = {
  attempt: 1,
  percent: 20,
  phase: "encoding" as const,
  revision: 3,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("exposes append-only finite event operations", async () => {
  await expect(import("../src/database/job-event-repository.ts")).resolves.toMatchObject({
    appendJobEvent: expect.any(Function),
    listOwnedJobEvents: expect.any(Function),
  });
});

it("returns globally sequenced job events in finite ordered pages", async () => {
  const database = await createTestDatabase();
  appendJobEvent(database.db, eventInput("owned-job", "created", 10));
  appendJobEvent(database.db, eventInput("other-job", "created", 11));
  appendJobEvent(database.db, {
    ...eventInput("owned-job", "progress", 12),
  });

  const first = await Effect.runPromise(
    listOwnedJobEvents(database, {
      after: 0,
      jobId: "owned-job",
      limit: 1,
      organizationId: "org-1",
    }),
  );
  expect(first).toMatchObject({
    events: [{ jobId: "owned-job", kind: "created", sequence: 1 }],
    nextCursor: 1,
  });
  const second = await Effect.runPromise(
    listOwnedJobEvents(database, {
      after: first?.nextCursor ?? 0,
      jobId: "owned-job",
      limit: 10,
      organizationId: "org-1",
    }),
  );
  expect(second).toEqual({
    organizationId: "org-1",
    events: [
      {
        attempt: 1,
        jobId: "owned-job",
        kind: "progress",
        occurredAt: new Date(12).toISOString(),
        progress,
        sequence: 3,
        state: "processing",
      },
    ],
    nextCursor: 3,
  });
  database.close();
});

it("makes foreign and missing event streams indistinguishable", async () => {
  const database = await createTestDatabase();
  appendJobEvent(database.db, eventInput("owned-job", "created", 10));

  await expect(
    Effect.runPromise(
      listOwnedJobEvents(database, {
        after: 0,
        jobId: "owned-job",
        limit: 10,
        organizationId: "org-2",
      }),
    ),
  ).resolves.toBeUndefined();
  await expect(
    Effect.runPromise(
      listOwnedJobEvents(database, {
        after: 0,
        jobId: "missing",
        limit: 10,
        organizationId: "org-1",
      }),
    ),
  ).resolves.toBeUndefined();
  database.close();
});

it("can append an event in the transaction that owns its visible mutation", async () => {
  const database = await createTestDatabase();

  expect(() =>
    database.db.transaction((transaction) => {
      appendJobEvent(transaction, eventInput("owned-job", "created", 10));
      throw new Error("roll back");
    }),
  ).toThrow("roll back");
  expect(database.db.select().from(jobEvents).all()).toEqual([]);
  database.close();
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-job-events-"));
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
  seedJob(database, "owned-job", "org-1");
  seedJob(database, "other-job", "org-2");
  return database;
};

const seedJob = (database: Database, id: string, organizationId: string) =>
  database.db
    .insert(jobs)
    .values(seedJobInput(database, { id, organizationId, state: "processing" }))
    .run();

const eventInput = (jobId: string, kind: "created" | "progress", occurredAt: number) => ({
  attempt: 1,
  jobId,
  kind,
  occurredAt,
  progress,
  state: "processing" as const,
});
