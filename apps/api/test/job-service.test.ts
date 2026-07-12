import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { jobs, users } from "../src/database/schema.ts";
import {
  JobIdempotencyConflict,
  JobUploadExpired,
  makeJobService,
} from "../src/jobs/job-service.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";

const NOW = 1_800_000_000_000;
const encoder = new TextEncoder();
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

it("creates an awaiting-upload job and makes identical idempotent retries stable", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const input = {
    idempotencyKey: "request-1",
    now: NOW,
    options: {},
    plan: "free" as const,
    source: { bytes: 5, filename: "input.mp4" },
    userId: "user-1",
    workflow: "compress" as const,
  };

  const first = await Effect.runPromise(service.create(input));
  const second = await Effect.runPromise(service.create({ ...input, now: NOW + 1 }));
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, first.jobId));

  expect(second).toEqual(first);
  expect(first).toMatchObject({ state: "awaiting-upload" });
  expect(first.upload.url).toBe(`https://media.example/v1/jobs/${first.jobId}/upload`);
  expect(database.db.select().from(jobs).all()).toHaveLength(1);
  await expect(access(paths.stagingDirectory)).resolves.toBeUndefined();
});

it("rejects an idempotency key reused for a different request", async () => {
  const { service } = await createTestContext();
  const input = {
    idempotencyKey: "request-1",
    now: NOW,
    options: {},
    plan: "free" as const,
    source: { bytes: 5, filename: "input.mp4" },
    userId: "user-1",
    workflow: "compress" as const,
  };
  await Effect.runPromise(service.create(input));

  const error = await Effect.runPromise(
    Effect.flip(service.create({ ...input, source: { bytes: 6, filename: "other.mp4" } })),
  );

  expect(error).toBeInstanceOf(JobIdempotencyConflict);
});

it("streams the declared upload and queues the job exactly once", async () => {
  const { database, service } = await createTestContext();
  const created = await createCompressionJob(service);

  const uploaded = await Effect.runPromise(
    service.upload({
      body: stream("hello"),
      jobId: created.jobId,
      now: NOW + 1,
      userId: "user-1",
    }),
  );

  expect(uploaded).toEqual({
    bytes: 5,
    jobId: created.jobId,
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    state: "queued",
  });
  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()).toMatchObject({
    inputBytes: 5,
    state: "queued",
  });
});

it("expires an unuploaded job and removes all of its workspace", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));

  const error = await Effect.runPromise(
    Effect.flip(
      service.upload({
        body: stream("hello"),
        jobId: created.jobId,
        now: NOW + 60_000,
        userId: "user-1",
      }),
    ),
  );

  expect(error).toBeInstanceOf(JobUploadExpired);
  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()?.state).toBe(
    "expired",
  );
  await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries idempotent workspace cleanup for an already canceled job", async () => {
  const { mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  await Effect.runPromise(
    service.upload({ body: stream("hello"), jobId: created.jobId, now: NOW + 1, userId: "user-1" }),
  );
  await Effect.runPromise(
    service.cancel({
      correlationId: "request-1",
      jobId: created.jobId,
      now: NOW + 2,
      userId: "user-1",
    }),
  );
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));
  await Effect.runPromise(prepareJobWorkspace(paths));
  await writeFile(paths.inputFile, "leftover");

  await Effect.runPromise(
    service.cancel({
      correlationId: "request-2",
      jobId: created.jobId,
      now: NOW + 3,
      userId: "user-1",
    }),
  );

  await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

const createTestContext = async () => {
  const root = await mkdtemp(join(tmpdir(), "ffmpeg-api-job-service-"));
  temporaryDirectories.push(root);
  const database = openDatabase(join(root, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  database.db
    .insert(users)
    .values({ createdAt: NOW, email: "agent@example.com", id: "user-1", updatedAt: NOW })
    .run();
  const mediaRoot = join(root, "media");
  const service = makeJobService(database, {
    maxUploadBytes: 1_000,
    mediaRoot,
    publicBaseUrl: "https://media.example",
    uploadTtlMs: 60_000,
  });
  return { database, mediaRoot, service };
};

type JobService = ReturnType<typeof makeJobService>;

const createCompressionJob = (service: JobService) =>
  Effect.runPromise(
    service.create({
      now: NOW,
      options: {},
      plan: "free",
      source: { bytes: 5, filename: "input.mp4" },
      userId: "user-1",
      workflow: "compress",
    }),
  );

const stream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
