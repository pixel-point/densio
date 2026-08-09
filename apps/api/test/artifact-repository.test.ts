import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import {
  ArtifactUnavailable,
  cleanupExpiredArtifacts,
  findSignedArtifact,
  registerArtifact,
} from "../src/database/artifact-repository.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { artifacts, jobs, users } from "../src/database/schema.ts";

const NOW = 1_800_000_000_000;
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

it("persists only a hash and resolves a signed artifact until expiry", async () => {
  const { database, mediaRoot } = await createTestContext();
  const path = join(mediaRoot, "job-1", "artifacts", "video.webm");
  await mkdir(join(mediaRoot, "job-1", "artifacts"), { recursive: true });
  await writeFile(path, "video");

  const registered = await Effect.runPromise(
    registerArtifact(database, {
      expiresAt: NOW + 60_000,
      filename: "video.webm",
      jobId: "job-1",
      kind: "video",
      mediaType: "video/webm",
      now: NOW,
      path,
      publicBaseUrl: "https://media.example",
      sha256: "a".repeat(64),
      sizeBytes: 5,
    }),
  );
  const row = database.db.select().from(artifacts).get();

  expect(registered.downloadUrl).toMatch(
    /^https:\/\/media\.example\/v1\/artifacts\/[\w-]+\/[A-Za-z0-9_-]{43}\/video\.webm$/,
  );
  expect(JSON.stringify(row)).not.toContain(registered.accessToken);
  await expect(
    Effect.runPromise(
      findSignedArtifact(database, {
        artifactId: registered.id,
        now: NOW + 59_999,
        token: registered.accessToken,
      }),
    ),
  ).resolves.toMatchObject({ filename: "video.webm", path });
  await expect(
    Effect.runPromise(
      Effect.flip(
        findSignedArtifact(database, {
          artifactId: registered.id,
          now: NOW + 60_000,
          token: registered.accessToken,
        }),
      ),
    ),
  ).resolves.toBeInstanceOf(ArtifactUnavailable);
});

it("deletes expired files before marking their rows inaccessible", async () => {
  const { database, mediaRoot } = await createTestContext();
  const path = join(mediaRoot, "job-1", "artifacts", "video.webm");
  await mkdir(join(mediaRoot, "job-1", "artifacts"), { recursive: true });
  await writeFile(path, "video");
  await registerTestArtifact(database, path, NOW);

  const outcome = await Effect.runPromise(
    cleanupExpiredArtifacts(database, { mediaRoot, now: NOW }),
  );

  expect(outcome).toEqual({ deleted: 1, failed: 0 });
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(database.db.select().from(artifacts).get()).toMatchObject({
    deletedAt: NOW,
    deletionError: null,
  });
});

it("refuses cleanup paths outside the configured media root and leaves them retryable", async () => {
  const { database, mediaRoot, root } = await createTestContext();
  const outsidePath = join(root, "do-not-delete.txt");
  await writeFile(outsidePath, "important");
  await registerTestArtifact(database, outsidePath, NOW);

  const outcome = await Effect.runPromise(
    cleanupExpiredArtifacts(database, { mediaRoot, now: NOW }),
  );

  expect(outcome).toEqual({ deleted: 0, failed: 1 });
  await expect(access(outsidePath)).resolves.toBeUndefined();
  expect(
    database.db.select().from(artifacts).where(eq(artifacts.path, outsidePath)).get(),
  ).toMatchObject({
    deletedAt: null,
    deletionError: "unsafe-path",
  });
});

const createTestContext = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-artifacts-"));
  temporaryDirectories.push(root);
  const database = openDatabase(join(root, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  const mediaRoot = join(root, "media");
  await mkdir(mediaRoot);
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
      state: "processing",
      updatedAt: NOW,
      userId: "user-1",
    })
    .run();
  return { database, mediaRoot, root };
};

const registerTestArtifact = (database: Database, path: string, expiresAt: number) =>
  Effect.runPromise(
    registerArtifact(database, {
      expiresAt,
      filename: "video.webm",
      jobId: "job-1",
      kind: "video",
      mediaType: "video/webm",
      now: NOW - 1,
      path,
      publicBaseUrl: "https://media.example",
      sha256: "a".repeat(64),
      sizeBytes: 5,
    }),
  );
