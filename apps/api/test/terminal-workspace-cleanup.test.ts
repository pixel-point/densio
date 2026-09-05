import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedJobInput } from "./job-fixture.ts";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { artifactAccessGrants, artifacts, jobs, users } from "../src/database/schema.ts";
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
  expect(await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot))).toEqual({
    deleted: 0,
    failed: 0,
  });
  await expect(access(terminal.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(queued.inputFile)).resolves.toBeUndefined();
});

it("reconciles partial artifacts for unsuccessful terminal jobs and preserves succeeded ones", async () => {
  const { database, mediaRoot } = await createTestContext();
  const failed = await seedJob(database, mediaRoot, "failed", "failed");
  const canceled = await seedJob(database, mediaRoot, "canceled", "canceled");
  const orphan = await seedJob(database, mediaRoot, "orphan", "failed");
  const succeeded = await seedJob(database, mediaRoot, "succeeded", "succeeded");
  const failedArtifact = await seedArtifact(database, failed.artifactDirectory, "failed", null);
  await seedArtifact(database, canceled.artifactDirectory, "canceled", NOW - 1);
  await mkdir(orphan.artifactDirectory, { recursive: true });
  await writeFile(join(orphan.artifactDirectory, "orphan.webm"), "orphan");
  const succeededArtifact = await seedArtifact(
    database,
    succeeded.artifactDirectory,
    "succeeded",
    null,
  );

  const result = await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot));

  expect(result).toEqual({ deleted: 4, failed: 0 });
  await expect(access(failed.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(canceled.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(orphan.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(succeededArtifact)).resolves.toBeUndefined();
  await expect(access(succeeded.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(database.db.select().from(artifacts).all()).toEqual([
    expect.objectContaining({ id: "artifact-succeeded" }),
  ]);
  expect(database.db.select().from(artifactAccessGrants).all()).toEqual([
    expect.objectContaining({ artifactId: "artifact-succeeded" }),
  ]);
  await expect(access(failedArtifact)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries terminal artifact reconciliation after directory removal but before row deletion", async () => {
  const { database, mediaRoot } = await createTestContext();
  const failed = await seedJob(database, mediaRoot, "failed", "failed");
  await seedArtifact(database, failed.artifactDirectory, "failed", null);
  database.sqlite.exec(`
    create trigger fail_terminal_artifact_delete
    before delete on artifacts
    when OLD.job_id = 'failed'
    begin
      select raise(abort, 'deterministic terminal artifact deletion failure');
    end
  `);

  const first = await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot));

  expect(first).toEqual({ deleted: 0, failed: 1 });
  await expect(access(failed.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(database.db.select().from(artifactAccessGrants).all()).toEqual([]);
  expect(database.db.select().from(artifacts).get()).toMatchObject({
    deletedAt: expect.any(Number),
    id: "artifact-failed",
  });

  database.sqlite.exec("drop trigger fail_terminal_artifact_delete");
  const retry = await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot));

  expect(retry).toEqual({ deleted: 1, failed: 0 });
  expect(database.db.select().from(artifacts).all()).toEqual([]);
  await expect(access(failed.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("cleans later pages despite a failed item and retries only that pending item", async () => {
  const { database, mediaRoot } = await createTestContext();
  await Promise.all(
    Array.from({ length: 51 }, (_, index) =>
      seedJob(database, mediaRoot, `page-${String(index).padStart(2, "0")}`, "failed"),
    ),
  );
  database.sqlite.exec(
    "create trigger fail_first_cleanup before update on jobs when OLD.id = 'page-00' and NEW.workspace_cleaned_at is not null begin select raise(abort, 'retry later'); end",
  );
  expect(await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot))).toEqual({
    deleted: 50,
    failed: 1,
  });
  database.sqlite.exec("drop trigger fail_first_cleanup");
  expect(await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot))).toEqual({
    deleted: 1,
    failed: 0,
  });
  expect(await Effect.runPromise(cleanupTerminalJobWorkspaces(database, mediaRoot))).toEqual({
    deleted: 0,
    failed: 0,
  });
});

const createTestContext = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-terminal-cleanup-"));
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
  state: "canceled" | "failed" | "queued" | "succeeded",
) => {
  database.db
    .insert(jobs)
    .values(
      seedJobInput(database, {
        createdAt: NOW,
        id,
        state,
        updatedAt: NOW,
        organizationId: "org-1",
      }),
    )
    .run();
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, id));
  await Effect.runPromise(prepareJobWorkspace(paths));
  await writeFile(paths.inputFile, "video");
  return paths;
};

const seedArtifact = async (
  database: Database,
  artifactDirectory: string,
  jobId: string,
  deletedAt: number | null,
) => {
  const id = `artifact-${jobId}`;
  const path = join(artifactDirectory, `${jobId}.webm`);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path, "artifact");
  database.db
    .insert(artifacts)
    .values({
      organizationId: "org-1",
      createdAt: NOW,
      deletedAt,
      filename: `${jobId}.webm`,
      id,
      jobId,
      kind: "video",
      mediaType: "video/webm",
      path,
      retainedUntil: NOW + 60_000,
      sha256: "a".repeat(64),
      sizeBytes: 8,
    })
    .run();
  database.db
    .insert(artifactAccessGrants)
    .values({
      issuingMembershipId: "membership-org-1-user-1",
      artifactId: id,
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      id: `grant-${jobId}`,
      tokenHash: `sha256.grant-${jobId}`,
    })
    .run();
  return path;
};
