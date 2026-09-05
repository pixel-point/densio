import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import {
  ArtifactUnavailable,
  authorizeOwnedArtifact,
  cleanupExpiredArtifacts,
  findGrantedArtifact,
} from "../src/database/artifact-repository.ts";
import { fixtureOrganizationActor } from "./organization-fixture-identity.ts";
import { artifactAccessGrants, artifacts } from "../src/database/schema.ts";
import { createJobTestContext, cleanupJobFixtures, succeedCanonicalJob } from "./job-fixture.ts";

const NOW = 1_800_000_000_000;
afterEach(cleanupJobFixtures);

it("persists only token hashes and expires each grant independently of retention", async () => {
  const { database, path } = await createTestArtifact(NOW + 60_000);
  const grant = await Effect.runPromise(
    authorizeOwnedArtifact(database, {
      artifactId: "artifact-1",
      ...fixtureOrganizationActor,
      now: NOW,
      accessTtlMs: 5_000,
    }),
  );
  if (grant.kind !== "authorized") throw new Error("Expected authorization");
  expect(JSON.stringify(database.db.select().from(artifactAccessGrants).all())).not.toContain(
    grant.token,
  );
  await expect(
    Effect.runPromise(
      findGrantedArtifact(database, {
        artifactId: "artifact-1",
        token: grant.token,
        now: NOW + 4_999,
      }),
    ),
  ).resolves.toMatchObject({ path });
  await expect(
    Effect.runPromise(
      Effect.flip(
        findGrantedArtifact(database, {
          artifactId: "artifact-1",
          token: grant.token,
          now: NOW + 5_000,
        }),
      ),
    ),
  ).resolves.toBeInstanceOf(ArtifactUnavailable);
  const replacement = await Effect.runPromise(
    authorizeOwnedArtifact(database, {
      artifactId: "artifact-1",
      ...fixtureOrganizationActor,
      now: NOW + 5_000,
      accessTtlMs: 5_000,
    }),
  );
  expect(replacement.kind).toBe("authorized");
});

it("tombstones expired artifacts and removes their bytes and grants", async () => {
  const { database, mediaRoot, path } = await createTestArtifact(NOW);
  await expect(
    Effect.runPromise(cleanupExpiredArtifacts(database, { mediaRoot, now: NOW })),
  ).resolves.toEqual({ deleted: 1, failed: 0 });
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(database.db.select().from(artifacts).get()).toMatchObject({
    deletedAt: NOW,
    deletionError: null,
  });
});

it("keeps bytes after grant expiry until physical retention elapses", async () => {
  const { database, mediaRoot, path } = await createTestArtifact(NOW + 60_000);
  await Effect.runPromise(
    authorizeOwnedArtifact(database, {
      artifactId: "artifact-1",
      ...fixtureOrganizationActor,
      now: NOW - 1,
      accessTtlMs: 1,
    }),
  );
  await expect(
    Effect.runPromise(cleanupExpiredArtifacts(database, { mediaRoot, now: NOW })),
  ).resolves.toEqual({ deleted: 0, failed: 0 });
  expect(database.db.select().from(artifactAccessGrants).all()).toEqual([]);
  await expect(access(path)).resolves.toBeUndefined();
  await expect(
    Effect.runPromise(cleanupExpiredArtifacts(database, { mediaRoot, now: NOW + 60_000 })),
  ).resolves.toEqual({ deleted: 1, failed: 0 });
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("revokes access before unsafe physical deletion and durably retries cleanup", async () => {
  const { database, mediaRoot, directory, path } = await createTestArtifact(NOW);
  const outsidePath = join(directory, "do-not-delete.txt");
  await writeFile(outsidePath, "important");
  database.db
    .update(artifacts)
    .set({ path: outsidePath })
    .where(eq(artifacts.id, "artifact-1"))
    .run();
  await expect(
    Effect.runPromise(cleanupExpiredArtifacts(database, { mediaRoot, now: NOW })),
  ).resolves.toEqual({ deleted: 0, failed: 1 });
  await expect(access(outsidePath)).resolves.toBeUndefined();
  expect(database.db.select().from(artifacts).get()).toMatchObject({
    deletedAt: NOW,
    deletionError: "unsafe-path",
  });
  database.db.update(artifacts).set({ path }).where(eq(artifacts.id, "artifact-1")).run();
  await expect(
    Effect.runPromise(cleanupExpiredArtifacts(database, { mediaRoot, now: NOW + 1 })),
  ).resolves.toEqual({ deleted: 1, failed: 0 });
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(outsidePath)).resolves.toBeUndefined();
});

const createTestArtifact = async (retainedUntil: number) => {
  const context = await createJobTestContext();
  const path = join(context.mediaRoot, "job-1", "artifacts", "video.webm");
  await mkdir(join(context.mediaRoot, "job-1", "artifacts"), { recursive: true });
  await writeFile(path, "video");
  succeedCanonicalJob(context.database, [
    {
      organizationId: "org-1",
      id: "artifact-1",
      jobId: "job-1",
      path,
      filename: "video.webm",
      kind: "video",
      mediaType: "video/webm",
      sha256: "a".repeat(64),
      sizeBytes: 5,
      retainedUntil,
      createdAt: NOW - 1,
    },
  ]);
  return { ...context, path };
};
