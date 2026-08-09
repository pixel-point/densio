import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { jobCreditEntries, jobs, users } from "../src/database/schema.ts";
import {
  JobCreditsExhausted,
  JobIdempotencyConflict,
  JobStateConflict,
  JobUploadExpired,
  makeJobService,
} from "../src/jobs/job-service.ts";
import {
  makeJobStoragePaths,
  prepareJobWorkspace,
  resolveStagedFile,
} from "../src/storage/workspace.ts";

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

it("rejects a new job before upload when all monthly credits are reserved", async () => {
  const { database, service } = await createTestContext();
  const existing = await createCompressionJob(service);
  database.db
    .insert(jobCreditEntries)
    .values({
      createdAt: NOW,
      id: "existing-adjustment",
      jobId: existing.jobId,
      kind: "adjustment",
      periodStart: Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth(), 1),
      units: 2_995,
      userId: "user-1",
    })
    .run();

  const error = await Effect.runPromise(
    Effect.flip(
      service.create({
        now: NOW,
        options: {},
        plan: "free",
        source: { bytes: 5, filename: "input.mp4" },
        userId: "user-1",
        workflow: "compress",
      }),
    ),
  );

  expect(error).toBeInstanceOf(JobCreditsExhausted);
  expect(error).toMatchObject({ availableCredits: 0, monthlyCredits: 30 });
  expect(database.db.select().from(jobs).all()).toHaveLength(1);
});

it("rejects a comparison duration above the configured server limit", async () => {
  const { database, service } = await createTestContext();

  await expect(
    Effect.runPromise(
      service.create({
        now: NOW,
        options: { codec: "vp9", crfs: [30, 40], durationSeconds: 3 },
        plan: "free",
        source: { bytes: 5, filename: "input.mp4" },
        userId: "user-1",
        workflow: "compare-quality",
      }),
    ),
  ).rejects.toMatchObject({ _tag: "JobComparisonDurationExceeded", limitSeconds: 1 });
  expect(database.db.select().from(jobs).all()).toEqual([]);
});

it("reports post-analysis credit exhaustion with billing recovery guidance", async () => {
  const { database, service } = await createTestContext();
  const created = await createCompressionJob(service);
  database.db
    .update(jobs)
    .set({
      completedAt: NOW + 1,
      errorCode: "CREDITS_EXHAUSTED",
      errorJson: '{"message":"Insufficient credits."}',
      state: "failed",
      updatedAt: NOW + 1,
    })
    .where(eq(jobs.id, created.jobId))
    .run();

  const status = await Effect.runPromise(
    service.status({ correlationId: "request-1", jobId: created.jobId, userId: "user-1" }),
  );

  expect(status).toMatchObject({
    problem: {
      code: "CREDITS_EXHAUSTED",
      status: 402,
      suggestedAction: "Wait for the monthly reset or upgrade the account plan.",
      title: "Credits exhausted",
    },
    state: "failed",
  });
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

it("allows only one concurrently staged upload to publish", async () => {
  const { mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));
  const gate = Promise.withResolvers<void>();
  const started = new Set<string>();
  const upload = (value: string) =>
    Effect.runPromise(
      service.upload({
        body: concurrentStream(value, started, gate),
        jobId: created.jobId,
        now: NOW + 1,
        userId: "user-1",
      }),
    );

  const results = await Promise.allSettled([upload("hello"), upload("world")]);

  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(results.filter(({ status }) => status === "rejected")).toEqual([
    expect.objectContaining({ reason: expect.any(JobStateConflict) }),
  ]);
  expect(["hello", "world"]).toContain(await readFile(paths.inputFile, "utf8"));
  await expect(readdir(paths.stagingDirectory)).resolves.toEqual([]);
});

it("does not report queued when cancellation wins finalization", async () => {
  const { database, service } = await createTestContext();
  const created = await createCompressionJob(service);
  database.sqlite.exec(`
    create trigger cancel_upload_after_claim
    after update of upload_state on jobs
    when new.upload_state = 'finalizing'
    begin
      update jobs set state = 'canceled' where id = new.id;
    end
  `);

  const error = await Effect.runPromise(
    Effect.flip(
      service.upload({
        body: stream("hello"),
        jobId: created.jobId,
        now: NOW + 1,
        userId: "user-1",
      }),
    ),
  );

  expect(error).toMatchObject({ _tag: "JobStateConflict", state: "canceled" });
});

it("recovers a published upload after a crash before queueing", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));
  const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  await writeFile(paths.inputFile, "hello");
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: sha256,
      uploadStagingFile: "upload-missing",
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, created.jobId))
    .run();

  await Effect.runPromise(service.recoverUploads({ now: NOW + 2 }));

  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()).toMatchObject({
    inputBytes: 5,
    inputSha256: sha256,
    state: "queued",
    uploadStagingFile: null,
    uploadState: "pending",
  });
});

it("publishes a validated staging file while recovering an upload", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));
  const stagingFile = "upload-recovery";
  const stagingPath = await Effect.runPromise(resolveStagedFile(paths, stagingFile));
  const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  await writeFile(stagingPath, "hello");
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: sha256,
      uploadStagingFile: stagingFile,
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, created.jobId))
    .run();

  await Effect.runPromise(service.recoverUploads({ now: NOW + 2 }));

  await expect(access(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(paths.inputFile)).resolves.toBeUndefined();
  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()?.state).toBe(
    "queued",
  );
});

it("replaces an invalid canonical file with validated staging bytes", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));
  const stagingFile = "upload-replacement";
  const stagingPath = await Effect.runPromise(resolveStagedFile(paths, stagingFile));
  const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  await writeFile(paths.inputFile, "wrong");
  await writeFile(stagingPath, "hello");
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: sha256,
      uploadStagingFile: stagingFile,
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, created.jobId))
    .run();

  await Effect.runPromise(service.recoverUploads({ now: NOW + 2 }));

  await expect(readFile(paths.inputFile, "utf8")).resolves.toBe("hello");
  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()?.state).toBe(
    "queued",
  );
});

it("resets a finalizing upload when no validated file can be recovered", async () => {
  const { database, service } = await createTestContext();
  const created = await createCompressionJob(service);
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploadStagingFile: "upload-missing",
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, created.jobId))
    .run();

  await Effect.runPromise(service.recoverUploads({ now: NOW + 2 }));

  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()).toMatchObject({
    inputBytes: null,
    inputSha256: null,
    state: "awaiting-upload",
    uploadStagingFile: null,
    uploadState: "pending",
  });
});

it("finishes an interrupted upload when the client retries", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));
  const stagingFile = "upload-interrupted";
  const stagingPath = await Effect.runPromise(resolveStagedFile(paths, stagingFile));
  const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  await writeFile(stagingPath, "hello");
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: sha256,
      uploadStagingFile: stagingFile,
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, created.jobId))
    .run();

  const result = await Effect.runPromise(
    service.upload({
      body: stream("world"),
      jobId: created.jobId,
      now: NOW + 2,
      userId: "user-1",
    }),
  );

  expect(result).toEqual({ bytes: 5, jobId: created.jobId, sha256, state: "queued" });
  await expect(readFile(paths.inputFile, "utf8")).resolves.toBe("hello");
  await expect(readdir(paths.stagingDirectory)).resolves.toEqual([]);
});

it("does not disturb an upload that is still streaming", async () => {
  const { service } = await createTestContext();
  const created = await createCompressionJob(service);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const upload = Effect.runPromise(
    service.upload({
      body: gatedStream("hello", started, release),
      jobId: created.jobId,
      now: NOW + 1,
      userId: "user-1",
    }),
  );
  await started.promise;

  await Effect.runPromise(service.recoverUploads({ now: NOW + 2 }));
  release.resolve();

  await expect(upload).resolves.toMatchObject({ jobId: created.jobId, state: "queued" });
});

it("does not let a full pending batch starve finalizing upload recovery", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  await Promise.all(Array.from({ length: 50 }, () => createCompressionJob(service)));
  const finalizing = await Effect.runPromise(
    service.create({
      now: NOW + 1,
      options: {},
      plan: "free",
      source: { bytes: 5, filename: "input.mp4" },
      userId: "user-1",
      workflow: "compress",
    }),
  );
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, finalizing.jobId));
  await writeFile(paths.inputFile, "hello");
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, finalizing.jobId))
    .run();

  await Effect.runPromise(service.recoverUploads({ now: NOW + 2 }));

  expect(database.db.select().from(jobs).where(eq(jobs.id, finalizing.jobId)).get()?.state).toBe(
    "queued",
  );
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

it("expires abandoned uploads during maintenance and releases their credit holds", async () => {
  const { database, mediaRoot, service } = await createTestContext();
  const created = await createCompressionJob(service);
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, created.jobId));

  await Effect.runPromise(service.recoverUploads({ now: NOW + 60_000 }));

  expect(database.db.select().from(jobs).where(eq(jobs.id, created.jobId)).get()?.state).toBe(
    "expired",
  );
  expect(
    database.db
      .select({ kind: jobCreditEntries.kind, units: jobCreditEntries.units })
      .from(jobCreditEntries)
      .all(),
  ).toEqual([
    { kind: "hold", units: 5 },
    { kind: "release", units: 5 },
  ]);
  await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("expires pending uploads even when another recovery fails", async () => {
  const { database, service } = await createTestContext();
  const abandoned = await createCompressionJob(service);
  const broken = await createCompressionJob(service);
  database.db
    .update(jobs)
    .set({
      inputBytes: 5,
      inputSha256: "a".repeat(64),
      uploadStagingFile: "../invalid",
      uploadState: "finalizing",
    })
    .where(eq(jobs.id, broken.jobId))
    .run();

  await Effect.runPromise(Effect.result(service.recoverUploads({ now: NOW + 60_000 })));

  expect(database.db.select().from(jobs).where(eq(jobs.id, abandoned.jobId)).get()?.state).toBe(
    "expired",
  );
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
    maxComparisonSeconds: 1,
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

const concurrentStream = (value: string, started: Set<string>, gate: PromiseWithResolvers<void>) =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      started.add(value);
      if (started.size === 2) gate.resolve();
      await gate.promise;
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });

const gatedStream = (
  value: string,
  started: PromiseWithResolvers<void>,
  release: PromiseWithResolvers<void>,
) =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      started.resolve();
      await release.promise;
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
