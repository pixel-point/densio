import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../src/database/database.ts";
import { claimNextJob } from "../src/database/job-repository.ts";
import { jobEvents, jobs, users } from "../src/database/schema.ts";
import { makeRecordingMediaProcessRunner } from "../src/jobs/job-command-recorder.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";

import { queueCanonicalJob } from "./job-fixture.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("turns observed FFmpeg time into fenced output progress and ETA", async () => {
  const database = await createDatabase();
  const job = database.db.select().from(jobs).where(eq(jobs.id, "job-1")).get();
  if (job === undefined) throw new Error("Expected active job");
  const runner = MediaProcessRunner.of({
    run: (command) =>
      Effect.sync(() => {
        command.progressObserver?.({
          frame: 60,
          outTimeSeconds: 4,
          progress: "continue",
          speed: 2,
        });
        return { exitCode: 0, stderrTail: "", stdout: "", stdoutTruncated: false };
      }),
  });
  const recording = makeRecordingMediaProcessRunner(database, job, runner, "ffprobe");

  await Effect.runPromise(
    recording.run({
      arguments: ["-i", "input.mp4", "output.webm"],
      executable: "ffmpeg",
      progressContext: {
        codec: "vp9",
        filename: "video-vp9.webm",
        index: 1,
        phase: "encoding",
        total: 1,
        totalDurationSeconds: 10,
      },
    }),
  );

  const stored = database.db.select().from(jobs).where(eq(jobs.id, "job-1")).get();
  expect(JSON.parse(stored?.progressJson ?? "null")).toEqual({
    activeOutputs: [
      {
        codec: "vp9",
        etaSeconds: { maximum: 3.75, minimum: 2.25 },
        filename: "video-vp9.webm",
        index: 1,
        processedDurationSeconds: 4,
        total: 1,
        totalDurationSeconds: 10,
      },
    ],
    attempt: 1,
    percent: 46,
    phase: "encoding",
    revision: 4,
  });
  expect(database.db.select({ kind: jobEvents.kind }).from(jobEvents).all().at(-1)).toEqual({
    kind: "progress",
  });
  database.close();
});

it("advances through preparing, encoding, and measuring bands without regression", async () => {
  const database = await createDatabase();
  const job = database.db.select().from(jobs).where(eq(jobs.id, "job-1")).get();
  if (job === undefined) throw new Error("Expected active job");
  const runner = MediaProcessRunner.of({
    run: (command) =>
      Effect.sync(() => {
        command.progressObserver?.(
          command.progressContext?.phase === "measuring"
            ? { outTimeSeconds: 2, progress: "continue", speed: 1 }
            : { progress: "end" },
        );
        return { exitCode: 0, stderrTail: "", stdout: "", stdoutTruncated: false };
      }),
  });
  const recording = makeRecordingMediaProcessRunner(database, job, runner, "ffprobe");
  const context = {
    filename: "comparison.webm",
    index: 1,
    total: 1,
    totalDurationSeconds: 10,
    variantId: "variant-vp9-crf-30",
  } as const;

  await Effect.runPromise(
    recording.run({
      arguments: ["prepare"],
      executable: "ffmpeg",
      progressContext: { ...context, phase: "preparing" },
    }),
  );
  expect(
    JSON.parse(
      database.db.select().from(jobs).where(eq(jobs.id, "job-1")).get()?.progressJson ?? "null",
    ),
  ).toMatchObject({ percent: 20, phase: "preparing" });
  await Effect.runPromise(
    recording.run({
      arguments: ["encode"],
      executable: "ffmpeg",
      progressContext: { ...context, phase: "encoding" },
    }),
  );
  await Effect.runPromise(
    recording.run({
      arguments: ["measure"],
      executable: "ffmpeg",
      progressContext: { ...context, phase: "measuring" },
    }),
  );

  const stored = database.db.select().from(jobs).where(eq(jobs.id, "job-1")).get();
  expect(JSON.parse(stored?.progressJson ?? "null")).toMatchObject({
    activeOutputs: [{ index: 1, processedDurationSeconds: 2, totalDurationSeconds: 10 }],
    percent: 87,
    phase: "measuring",
  });
  database.close();
});

const createDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-command-progress-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  migrateDatabase(database);
  database.db
    .insert(users)
    .values({ createdAt: 1, email: "owner@example.com", id: "owner", updatedAt: 1 })
    .run();
  const job = queueCanonicalJob(database, { organizationId: "org-1", createdByUserId: "owner" });
  claimNextJob(database, {
    leaseDurationMs: 10_000_000_000_000,
    now: 10,
    workerId: "worker-1",
  });
  transitionJob(database, {
    jobId: job.id,
    now: 20,
    command: {
      type: "processing",
      workerId: "worker-1",
      attempt: 1,
      creditUnits: job.quoteCreditUnits,
      leaseDurationMs: 10_000_000_000_000,
    },
  });
  return database;
};
