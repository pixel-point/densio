import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { jobCreditEntries, jobs, preparedSources } from "../src/database/schema.ts";
import { recoverPreparingJobs } from "../src/jobs/job-admission-service.ts";
import { makeJobStoragePaths } from "../src/storage/workspace.ts";
import { makeSourceStoragePaths } from "../src/storage/source-workspace.ts";
import {
  createJobTestContext,
  cleanupJobFixtures,
  seedCanonicalJob,
  sourceBytes,
} from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("visits later preparation pages even while earlier jobs remain retryable", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  for (let index = 0; index < 51; index += 1) {
    const id = `job-${String(index).padStart(2, "0")}`;
    seedCanonicalJob(database, { id });
    if (index === 50) continue;
    const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, id));
    await mkdir(paths.workspaceDirectory, { recursive: true });
    await writeFile(dirname(paths.inputFile), "not-a-directory");
  }
  await Effect.runPromise(recoverPreparingJobs(database, mediaRoot, 10));
  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-50")).get()?.state).toBe("failed");
});

it("recovers persisted preparation concurrently without duplicate holds or queue transitions", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  const job = seedCanonicalJob(database);
  const source = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, job.sourceId));
  await mkdir(dirname(source.inputFile), { recursive: true });
  await writeFile(source.inputFile, sourceBytes);
  await Effect.runPromise(
    Effect.all(
      [
        recoverPreparingJobs(database, mediaRoot, 10),
        recoverPreparingJobs(database, mediaRoot, 10),
      ],
      { concurrency: "unbounded" },
    ),
  );
  expect(database.db.select().from(jobs).get()).toMatchObject({ state: "queued", revision: 1 });
  expect(database.db.select().from(jobCreditEntries).all()).toHaveLength(1);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, job.id));
  expect(await readFile(paths.inputFile)).toEqual(sourceBytes);
});

it("preserves an already attached input independently of source deletion", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  const job = seedCanonicalJob(database);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, job.id));
  await mkdir(dirname(paths.inputFile), { recursive: true });
  await writeFile(paths.inputFile, sourceBytes);
  database.db
    .update(preparedSources)
    .set({ state: "deleted", deletedAt: 5 })
    .where(eq(preparedSources.id, job.sourceId))
    .run();
  await Effect.runPromise(recoverPreparingJobs(database, mediaRoot, 10));
  expect(database.db.select().from(jobs).get()?.state).toBe("queued");
  expect(await readFile(paths.inputFile)).toEqual(sourceBytes);
});

it("fails missing source input without invented execution evidence and releases the hold", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  const job = seedCanonicalJob(database);
  await Effect.runPromise(recoverPreparingJobs(database, mediaRoot, 10));
  const failed = database.db.select().from(jobs).get();
  expect(failed).toMatchObject({ state: "failed", errorCode: "PREPARED_SOURCE_UNAVAILABLE" });
  expect(JSON.parse(failed?.receiptJson ?? "{}").execution).toEqual({
    attempts: 0,
    completedAt: new Date(10).toISOString(),
    commands: [],
  });
  expect(database.db.select().from(jobCreditEntries).all()).toMatchObject([
    { kind: "hold", units: job.quoteCreditUnits },
    { kind: "release", units: job.quoteCreditUnits },
  ]);
});

it("retains transient I/O failures for retry while allowing unrelated preparation to proceed", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  seedCanonicalJob(database, { id: "blocked" });
  seedCanonicalJob(database, { id: "missing" });
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, "blocked"));
  await mkdir(paths.workspaceDirectory, { recursive: true });
  await writeFile(dirname(paths.inputFile), "not-a-directory");
  await Effect.runPromise(recoverPreparingJobs(database, mediaRoot, 10));
  expect(database.db.select().from(jobs).where(eq(jobs.id, "blocked")).get()?.state).toBe(
    "preparing",
  );
  expect(database.db.select().from(jobs).where(eq(jobs.id, "missing")).get()?.state).toBe("failed");
  expect(
    database.db.select().from(jobCreditEntries).where(eq(jobCreditEntries.jobId, "blocked")).all(),
  ).toHaveLength(1);
  await expect(access(dirname(paths.inputFile))).resolves.toBeUndefined();
});
