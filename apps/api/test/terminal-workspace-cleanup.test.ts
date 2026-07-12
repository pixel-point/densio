import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { jobs, users } from "../src/database/schema.ts";
import { cleanupTerminalJobWorkspaces } from "../src/jobs/terminal-workspace-cleanup.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";

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

it("retries terminal workspace deletion while preserving queued inputs", async () => {
  const { database, mediaRoot } = await createTestContext();
  const terminal = await seedJob(database, mediaRoot, "terminal", "failed");
  const queued = await seedJob(database, mediaRoot, "queued", "queued");

  const result = await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot));

  expect(result).toEqual({ deleted: 1, failed: 0 });
  await expect(access(terminal.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(queued.inputFile)).resolves.toBeUndefined();
});

const createTestContext = async () => {
  const root = await mkdtemp(join(tmpdir(), "ffmpeg-api-terminal-cleanup-"));
  temporaryDirectories.push(root);
  const database = openDatabase(join(root, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  database.db
    .insert(users)
    .values({ createdAt: NOW, email: "agent@example.com", id: "user-1", updatedAt: NOW })
    .run();
  return { database, mediaRoot: join(root, "media") };
};

const seedJob = async (
  database: Database,
  mediaRoot: string,
  id: string,
  state: "failed" | "queued",
) => {
  database.db
    .insert(jobs)
    .values({
      createdAt: NOW,
      declaredBytes: 5,
      id,
      kind: "compress",
      optionsJson: "{}",
      plan: "free",
      sourceFilename: "input.mp4",
      state,
      updatedAt: NOW,
      userId: "user-1",
    })
    .run();
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, id));
  await Effect.runPromise(prepareJobWorkspace(paths));
  await writeFile(paths.inputFile, "video");
  return paths;
};
