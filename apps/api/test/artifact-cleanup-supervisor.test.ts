import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { startArtifactCleanupSupervisor } from "../src/artifacts/artifact-cleanup-supervisor.ts";
import { registerArtifact } from "../src/database/artifact-repository.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { artifacts, jobs, users } from "../src/database/schema.ts";

const NOW = Date.now();
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

it("cleans expired artifacts at startup and stops promptly", async () => {
  const { database, mediaRoot, path } = await createTestContext();

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* startArtifactCleanupSupervisor(database, {
          intervalMs: 60_000,
          mediaRoot,
        });
        yield* waitUntil(() => database.db.select().from(artifacts).get()?.deletedAt !== null);
        yield* supervisor.stop();
      }),
    ),
  );

  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});

const createTestContext = async () => {
  const root = await mkdtemp(join(tmpdir(), "ffmpeg-api-artifact-supervisor-"));
  temporaryDirectories.push(root);
  const database = openDatabase(join(root, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  const mediaRoot = join(root, "media");
  const path = join(mediaRoot, "artifacts", "job-1", "video.webm");
  await mkdir(join(mediaRoot, "artifacts", "job-1"), { recursive: true });
  await writeFile(path, "video");
  database.db
    .insert(users)
    .values({ createdAt: NOW, email: "agent@example.com", id: "user-1", updatedAt: NOW })
    .run();
  database.db
    .insert(jobs)
    .values({
      createdAt: NOW,
      declaredBytes: 5,
      id: "job-1",
      kind: "compress",
      optionsJson: "{}",
      plan: "free",
      sourceFilename: "input.mp4",
      state: "succeeded",
      updatedAt: NOW,
      userId: "user-1",
    })
    .run();
  await Effect.runPromise(
    registerArtifact(database, {
      expiresAt: NOW - 1,
      filename: "video.webm",
      jobId: "job-1",
      kind: "video",
      mediaType: "video/webm",
      now: NOW - 2,
      path,
      publicBaseUrl: "https://media.example",
      sha256: "a".repeat(64),
      sizeBytes: 5,
    }),
  );
  return { database, mediaRoot, path };
};

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.sleep(5);
    }
    return yield* Effect.die("Timed out waiting for artifact cleanup");
  });
