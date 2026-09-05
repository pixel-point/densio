import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  claimPreparedSourceUpload,
  completePreparedSourceInspection,
  createPreparedSource,
  expireDuePreparedSources,
  deleteOwnedPreparedSource,
  expireOwnedPreparedSourceIfDue,
  failPreparedSourceInspection,
  findOwnedPreparedSource,
  listRecoverablePreparedSources,
  markPreparedSourceInspecting,
} from "../src/database/prepared-source-repository.ts";
import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
  otherFixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { preparedSources, users } from "../src/database/schema.ts";

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

describe("prepared source creation and ownership", () => {
  it("returns the original owner-scoped row for an idempotent create", async () => {
    const database = await testDatabase();
    const values = sourceValues("source-1", "user-1", "request-1");

    const first = createPreparedSource(database, values, fixtureOrganizationActor);
    const retried = createPreparedSource(
      database,
      {
        ...values,
        id: "source-2",
        updatedAt: NOW + 1,
      },
      fixtureOrganizationActor,
    );

    expect(first).toMatchObject({ created: true, source: { id: "source-1" } });
    expect(retried).toMatchObject({ created: false, source: { id: "source-1" } });
    expect(database.db.select().from(preparedSources).all()).toHaveLength(1);
    expect(
      findOwnedPreparedSource(database, { sourceId: "source-1", ...otherFixtureOrganizationActor }),
    ).toBeUndefined();
  });
});

describe("prepared source upload and inspection transitions", () => {
  it("claims finalization once and publishes into inspecting atomically", async () => {
    const database = await testDatabase();
    createPreparedSource(
      database,
      sourceValues("source-1", "user-1", null),
      fixtureOrganizationActor,
    );
    const claim = {
      bytes: 5,
      now: NOW + 1,
      sha256: "a".repeat(64),
      sourceId: "source-1",
      stagingFile: "upload-1",
      ...fixtureOrganizationActor,
    };

    expect(claimPreparedSourceUpload(database, claim)).toMatchObject({
      state: "finalizing",
      uploadStagingFile: "upload-1",
    });
    expect(claimPreparedSourceUpload(database, claim)).toBeUndefined();
    expect(markPreparedSourceInspecting(database, "source-1", NOW + 2)).toMatchObject({
      state: "inspecting",
      uploadStagingFile: null,
    });
  });

  it("completes or fails only an inspecting source", async () => {
    const database = await testDatabase();
    createPreparedSource(
      database,
      sourceValues("ready-source", "user-1", null),
      fixtureOrganizationActor,
    );
    createPreparedSource(
      database,
      sourceValues("failed-source", "user-1", null),
      fixtureOrganizationActor,
    );
    for (const sourceId of ["ready-source", "failed-source"]) {
      claimPreparedSourceUpload(database, {
        bytes: 5,
        now: NOW + 1,
        sha256: "a".repeat(64),
        sourceId,
        stagingFile: `upload-${sourceId}`,
        ...fixtureOrganizationActor,
      });
    }
    markPreparedSourceInspecting(database, "ready-source", NOW + 2);
    markPreparedSourceInspecting(database, "failed-source", NOW + 2);

    expect(
      completePreparedSourceInspection(database, {
        inspectionJson: '{"durationSeconds":1}',
        now: NOW + 3,
        sourceId: "ready-source",
      }),
    ).toMatchObject({ state: "ready" });
    expect(
      failPreparedSourceInspection(database, {
        errorCode: "SOURCE_INSPECTION_FAILED",
        errorJson: '{"reason":"no-video-stream"}',
        now: NOW + 3,
        sourceId: "failed-source",
      }),
    ).toMatchObject({ state: "failed" });
    expect(
      completePreparedSourceInspection(database, {
        inspectionJson: "{}",
        now: NOW + 4,
        sourceId: "failed-source",
      }),
    ).toBeUndefined();
  });
});

describe("prepared source recovery and expiry", () => {
  it("does not let a stale due-expiry overwrite a finalizing upload", async () => {
    const database = await testDatabase();
    createPreparedSource(
      database,
      sourceValues("source-race", "user-1", null),
      fixtureOrganizationActor,
    );
    claimPreparedSourceUpload(database, {
      bytes: 5,
      now: NOW + 1,
      sha256: "a".repeat(64),
      sourceId: "source-race",
      stagingFile: "upload-race",
      ...fixtureOrganizationActor,
    });

    expect(
      expireOwnedPreparedSourceIfDue(database, "source-race", "org-1", NOW + 30_000),
    ).toBeUndefined();
    expect(
      findOwnedPreparedSource(database, { sourceId: "source-race", ...fixtureOrganizationActor }),
    ).toMatchObject({
      state: "finalizing",
    });
  });

  it("expires pending uploads at their deadline but keeps finalizing uploads recoverable", async () => {
    const database = await testDatabase();
    createPreparedSource(
      database,
      sourceValues("finalizing", "user-1", null),
      fixtureOrganizationActor,
    );
    createPreparedSource(
      database,
      sourceValues("pending", "user-1", null),
      fixtureOrganizationActor,
    );
    claimPreparedSourceUpload(database, {
      bytes: 5,
      now: NOW + 1,
      sha256: "a".repeat(64),
      sourceId: "finalizing",
      stagingFile: "upload-finalizing",
      ...fixtureOrganizationActor,
    });

    expect(
      expireDuePreparedSources(database, { limit: 10, now: NOW + 30_000 }).map(({ id }) => id),
    ).toEqual(["pending"]);
    expect(listRecoverablePreparedSources(database, 10).map(({ id }) => id)).toEqual([
      "finalizing",
    ]);
  });
});

describe("prepared source terminal expiry", () => {
  it("lists finalizing and inspecting sources, then expires due rows idempotently", async () => {
    const database = await testDatabase();
    createPreparedSource(
      database,
      sourceValues("finalizing", "user-1", null),
      fixtureOrganizationActor,
    );
    createPreparedSource(
      database,
      sourceValues("inspecting", "user-1", null),
      fixtureOrganizationActor,
    );
    createPreparedSource(
      database,
      {
        ...sourceValues("future", "user-1", null),
        expiresAt: NOW + 100_000,
      },
      fixtureOrganizationActor,
    );
    claimPreparedSourceUpload(database, {
      bytes: 5,
      now: NOW + 1,
      sha256: "a".repeat(64),
      sourceId: "finalizing",
      stagingFile: "upload-finalizing",
      ...fixtureOrganizationActor,
    });
    claimPreparedSourceUpload(database, {
      bytes: 5,
      now: NOW + 1,
      sha256: "a".repeat(64),
      sourceId: "inspecting",
      stagingFile: "upload-inspecting",
      ...fixtureOrganizationActor,
    });
    markPreparedSourceInspecting(database, "inspecting", NOW + 2);

    expect(listRecoverablePreparedSources(database, 10).map(({ id }) => id)).toEqual([
      "finalizing",
      "inspecting",
    ]);
    expect(expireDuePreparedSources(database, { limit: 10, now: NOW + 60_001 })).toHaveLength(3);
    expect(expireDuePreparedSources(database, { limit: 10, now: NOW + 60_002 })).toEqual([]);
    expect(
      deleteOwnedPreparedSource(database, "future", otherFixtureOrganizationActor, NOW + 60_002),
    ).toBeUndefined();
    expect(
      deleteOwnedPreparedSource(database, "future", fixtureOrganizationActor, NOW + 60_002),
    ).toMatchObject({
      deletedAt: NOW + 60_002,
      state: "deleted",
    });
  });
});

const testDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-source-repository-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  database.db
    .insert(users)
    .values([
      { createdAt: NOW, email: "owner@example.com", id: "user-1", updatedAt: NOW },
      { createdAt: NOW, email: "other@example.com", id: "user-2", updatedAt: NOW },
    ])
    .run();
  ensureOrganizationActor(database);
  ensureOrganizationActor(database, "org-2", "user-2");
  return database;
};

const sourceValues = (id: string, userId: string, idempotencyKey: string | null) => ({
  createdAt: NOW,
  declaredBytes: 5,
  expiresAt: NOW + 60_000,
  id,
  idempotencyKey,
  maxUploadBytes: 1_000,
  requestDigest: "a".repeat(64),
  sourceFilename: "input.mp4",
  state: "awaiting-upload" as const,
  updatedAt: NOW,
  uploadExpiresAt: NOW + 30_000,
  organizationId: userId === "user-1" ? "org-1" : "org-2",
  createdByUserId: userId,
});
