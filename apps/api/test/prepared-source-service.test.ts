import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  claimPreparedSourceUpload,
  createPreparedSource,
} from "../src/database/prepared-source-repository.ts";
import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
  otherFixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { preparedSources, users } from "../src/database/schema.ts";
import { listSourceCleanupCandidates } from "../src/database/prepared-source-repository.ts";
import { withSourceWriteActivity } from "../src/sources/source-write-activity.ts";
import { MediaInspectionError } from "../src/media/inspection/media-inspection-error.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import {
  makePreparedSourceService,
  SourceIdempotencyConflict,
  SourceNotFound,
  SourceUploadExpired,
  SourceUploadLimitExceeded,
} from "../src/sources/prepared-source-service.ts";
import {
  makeSourceStoragePaths,
  prepareSourceWorkspace,
  resolveSourceStagedFile,
} from "../src/storage/source-workspace.ts";

const NOW = 1_800_000_000_000;
const digest = (contents: string) => createHash("sha256").update(contents).digest("hex");
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

it("recovers later pages despite a failing source without rescanning cleaned history", async () => {
  const fixture = await testContext(successfulInspector().service);
  for (let index = 0; index < 51; index += 1) {
    createPreparedSource(
      fixture.database,
      {
        id: `recovery-${String(index).padStart(2, "0")}`,
        organizationId: "org-1",
        createdByUserId: "user-1",
        sourceFilename: "input.mp4",
        declaredBytes: 5,
        maxUploadBytes: 100,
        state: "finalizing",
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: NOW + 120_000,
        uploadExpiresAt: NOW + 30_000,
        requestDigest: digest("request"),
      },
      fixtureOrganizationActor,
    );
  }
  fixture.database.sqlite.exec(
    "create trigger block_recovery before update on prepared_sources when OLD.id = 'recovery-00' begin select raise(abort, 'retry later'); end",
  );
  await Effect.runPromise(fixture.service.maintain({ now: NOW + 1 }));
  expect(
    fixture.database.db
      .select()
      .from(preparedSources)
      .where(eq(preparedSources.id, "recovery-50"))
      .get()?.state,
  ).toBe("failed");
  const paths = await Effect.runPromise(makeSourceStoragePaths(fixture.mediaRoot, "recovery-50"));
  await Effect.runPromise(fixture.service.maintain({ now: NOW + 2 }));
  await Effect.runPromise(fixture.service.maintain({ now: NOW + 3 }));
  expect(listSourceCleanupCandidates(fixture.database, 50)).toEqual([]);
  await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("waits for an active source writer before completing cleanup and rejects later writers", async () => {
  const fixture = await testContext(successfulInspector().service);
  const created = await Effect.runPromise(fixture.service.create(createInput()));
  const source = fixture.database.db.select().from(preparedSources).get()!;
  const paths = await Effect.runPromise(makeSourceStoragePaths(fixture.mediaRoot, source.id));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const writer = Effect.runPromise(
    withSourceWriteActivity(
      fixture.database,
      source,
      Effect.tryPromise(async () => {
        await Effect.runPromise(prepareSourceWorkspace(paths));
        started.resolve();
        await finish.promise;
        await writeFile(paths.inputFile, "late upload");
      }),
    ),
  );
  await started.promise;
  await Effect.runPromise(
    fixture.service.delete({
      ...fixtureOrganizationActor,
      sourceId: created.source.sourceId,
      now: NOW + 1,
    }),
  );
  await Effect.runPromise(fixture.service.maintain({ now: NOW + 2 }));
  expect(fixture.database.db.select().from(preparedSources).get()?.cleanedAt).toBeNull();
  await expect(access(paths.workspaceDirectory)).resolves.toBeUndefined();
  finish.resolve();
  await writer;
  await Effect.runPromise(fixture.service.maintain({ now: NOW + 3 }));
  await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    Effect.runPromise(withSourceWriteActivity(fixture.database, source, Effect.void)),
  ).rejects.toThrow();
});

describe("prepared source creation", () => {
  it("replays the original tombstone even if the caller's upload limit has since fallen", async () => {
    const fixture = await testContext(successfulInspector().service);
    const first = await Effect.runPromise(fixture.service.create(createInput()));
    await Effect.runPromise(
      fixture.service.delete({
        sourceId: first.source.sourceId,
        ...fixtureOrganizationActor,
        now: NOW + 1,
      }),
    );
    const replay = await Effect.runPromise(
      fixture.service.create({ ...createInput(), maxUploadBytes: 1, now: NOW + 2 }),
    );
    expect(replay).toMatchObject({
      replayed: true,
      source: { sourceId: first.source.sourceId, state: "deleted" },
    });
    expect(replay.source).not.toHaveProperty("upload");
  });

  it("creates a short-lived upload action and replays identical idempotent input", async () => {
    const fixture = await testContext(successfulInspector().service);
    const input = createInput();

    const first = await Effect.runPromise(fixture.service.create(input));
    const retried = await Effect.runPromise(fixture.service.create({ ...input, now: NOW + 1 }));

    expect(first).toMatchObject({
      replayed: false,
      source: {
        declaredBytes: 5,
        expiresAt: new Date(NOW + 120_000).toISOString(),
        state: "awaiting-upload",
        upload: { expiresAt: new Date(NOW + 30_000).toISOString(), method: "PUT" },
      },
    });
    expect(retried).toMatchObject({ replayed: true, source: { sourceId: first.source.sourceId } });
    expect(fixture.database.db.select().from(preparedSources).all()).toHaveLength(1);
    const paths = await Effect.runPromise(
      makeSourceStoragePaths(fixture.mediaRoot, first.source.sourceId),
    );
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an elapsed upload deadline as expired without an upload action", async () => {
    const fixture = await testContext(successfulInspector().service);
    const first = await Effect.runPromise(fixture.service.create(createInput()));
    const paths = await Effect.runPromise(
      makeSourceStoragePaths(fixture.mediaRoot, first.source.sourceId),
    );

    const replay = await Effect.runPromise(
      fixture.service.create({ ...createInput(), now: NOW + 30_000 }),
    );

    expect(replay).toMatchObject({
      replayed: true,
      source: { sourceId: first.source.sourceId, state: "expired" },
    });
    expect(replay.source).not.toHaveProperty("upload");
    expect(
      fixture.database.db
        .select({ state: preparedSources.state })
        .from(preparedSources)
        .where(eq(preparedSources.id, first.source.sourceId))
        .get(),
    ).toEqual({ state: "expired" });
    await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects conflicting retry input and declarations above the caller's upload limit", async () => {
    const fixture = await testContext(successfulInspector().service);
    await Effect.runPromise(fixture.service.create(createInput()));

    const conflict = await Effect.runPromise(
      Effect.flip(
        fixture.service.create({
          ...createInput(),
          filename: "different.mp4",
          now: NOW + 1,
        }),
      ),
    );
    const tooLarge = await Effect.runPromise(
      Effect.flip(
        fixture.service.create({
          ...createInput(),
          bytes: 1_001,
          idempotencyKey: "request-2",
        }),
      ),
    );

    expect(conflict).toBeInstanceOf(SourceIdempotencyConflict);
    expect(tooLarge).toBeInstanceOf(SourceUploadLimitExceeded);
    expect(tooLarge).toMatchObject({ limitBytes: 1_000 });
  });
});

describe("prepared source upload and inspection", () => {
  it("streams, hashes, publishes, and normalizes trusted inspection", async () => {
    const inspector = successfulInspector();
    const fixture = await testContext(inspector.service);
    const created = await Effect.runPromise(fixture.service.create(createInput()));

    const ready = await Effect.runPromise(
      fixture.service.upload({
        body: stream("hello"),
        correlationId: "request-1",
        now: NOW + 1,
        sourceId: created.source.sourceId,
        ...fixtureOrganizationActor,
      }),
    );

    expect(ready).toMatchObject({
      state: "ready",
      verifiedBytes: 5,
      sha256: digest("hello"),
      inspection: {
        durationSeconds: 3.5,
        encodedDimensions: { width: 640, height: 360 },
        displayDimensions: { width: 360, height: 640 },
        rotationDegrees: 90,
        frameRate: { numerator: 60_000, denominator: 1_001 },
        primaryVideoStream: { index: 0, codec: "h264", type: "video" },
        audioStreams: [{ index: 1, codec: "aac", type: "audio" }],
      },
    });
    expect(inspector.inspectedPaths).toHaveLength(1);
    const row = fixture.database.db
      .select()
      .from(preparedSources)
      .where(eq(preparedSources.id, created.source.sourceId))
      .get();
    expect(row).toMatchObject({ inputBytes: 5, inputSha256: digest("hello"), state: "ready" });

    const hidden = await Effect.runPromise(
      Effect.flip(
        fixture.service.status({
          correlationId: "request-2",
          now: NOW + 2,
          sourceId: created.source.sourceId,
          ...otherFixtureOrganizationActor,
        }),
      ),
    );
    expect(hidden).toBeInstanceOf(SourceNotFound);
  });

  it("persists a safe failed state and removes bytes when trusted inspection fails", async () => {
    const fixture = await testContext(failingInspector());
    const created = await Effect.runPromise(fixture.service.create(createInput()));

    const failed = await Effect.runPromise(
      fixture.service.upload({
        body: stream("hello"),
        correlationId: "upload-request",
        now: NOW + 1,
        sourceId: created.source.sourceId,
        ...fixtureOrganizationActor,
      }),
    );

    expect(failed).toMatchObject({
      state: "failed",
      problem: {
        code: "SOURCE_INSPECTION_FAILED",
        correlationId: "upload-request",
        retryable: false,
        status: 422,
      },
    });
    const paths = await Effect.runPromise(
      makeSourceStoragePaths(fixture.mediaRoot, created.source.sourceId),
    );
    await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      fixture.database.db
        .select()
        .from(preparedSources)
        .where(eq(preparedSources.id, created.source.sourceId))
        .get(),
    ).toMatchObject({ errorCode: "SOURCE_INSPECTION_FAILED", state: "failed" });
  });
});

describe("prepared source inspection normalization", () => {
  it("persists a failed state when normalized inspection violates the public contract", async () => {
    const fixture = await testContext(invalidNormalizedInspector());
    const created = await Effect.runPromise(fixture.service.create(createInput()));

    const failed = await Effect.runPromise(
      fixture.service.upload({
        body: stream("hello"),
        correlationId: "upload-request",
        now: NOW + 1,
        sourceId: created.source.sourceId,
        ...fixtureOrganizationActor,
      }),
    );

    expect(failed).toMatchObject({
      state: "failed",
      problem: { code: "SOURCE_INSPECTION_FAILED", status: 422 },
    });
  });
});

describe("prepared source expiry and recovery", () => {
  it("recovers one finalizing upload concurrently without destroying verified bytes", async () => {
    const fixture = await testContext(successfulInspector().service);
    const created = await Effect.runPromise(fixture.service.create(createInput()));
    const paths = await Effect.runPromise(
      makeSourceStoragePaths(fixture.mediaRoot, created.source.sourceId),
    );
    await Effect.runPromise(prepareSourceWorkspace(paths));
    const stagedPath = await Effect.runPromise(resolveSourceStagedFile(paths, "upload-concurrent"));
    await writeFile(stagedPath, "hello");
    claimPreparedSourceUpload(fixture.database, {
      bytes: 5,
      sha256: digest("hello"),
      now: NOW + 1,
      sourceId: created.source.sourceId,
      stagingFile: "upload-concurrent",
      ...fixtureOrganizationActor,
    });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        Effect.runPromise(fixture.service.maintain({ now: NOW + 2 })),
      ),
    );
    expect(
      await Effect.runPromise(
        fixture.service.status({
          sourceId: created.source.sourceId,
          ...fixtureOrganizationActor,
          now: NOW + 3,
          correlationId: "recovered",
        }),
      ),
    ).toMatchObject({ state: "ready", sha256: digest("hello") });
    await expect(access(paths.inputFile)).resolves.toBeUndefined();
  });

  it("expires a late upload and makes explicit deletion idempotent", async () => {
    const fixture = await testContext(successfulInspector().service);
    const late = await Effect.runPromise(fixture.service.create(createInput()));

    const expired = await Effect.runPromise(
      Effect.flip(
        fixture.service.upload({
          body: stream("hello"),
          correlationId: "request-1",
          now: NOW + 30_000,
          sourceId: late.source.sourceId,
          ...fixtureOrganizationActor,
        }),
      ),
    );
    expect(expired).toBeInstanceOf(SourceUploadExpired);

    const deletable = await Effect.runPromise(
      fixture.service.create({ ...createInput(), idempotencyKey: "delete-me", now: NOW + 1 }),
    );
    const first = await Effect.runPromise(
      fixture.service.delete({
        now: NOW + 2,
        sourceId: deletable.source.sourceId,
        ...fixtureOrganizationActor,
      }),
    );
    const second = await Effect.runPromise(
      fixture.service.delete({
        now: NOW + 3,
        sourceId: deletable.source.sourceId,
        ...fixtureOrganizationActor,
      }),
    );
    expect(second).toEqual(first);
    expect(first).toEqual({
      organizationId: "org-1",
      deletedAt: new Date(NOW + 2).toISOString(),
      sourceId: deletable.source.sourceId,
      state: "deleted",
    });
  });
});

describe("interrupted source recovery", () => {
  it("recovers finalizing and inspecting sources without accepting another upload", async () => {
    const fixture = await testContext(successfulInspector().service);
    const finalizing = await Effect.runPromise(
      fixture.service.create({ ...createInput(), idempotencyKey: "finalizing" }),
    );
    const finalizingPaths = await Effect.runPromise(
      makeSourceStoragePaths(fixture.mediaRoot, finalizing.source.sourceId),
    );
    const stagedPath = await Effect.runPromise(
      resolveSourceStagedFile(finalizingPaths, "upload-recovery"),
    );
    await Effect.runPromise(prepareSourceWorkspace(finalizingPaths));
    await writeFile(stagedPath, "hello");
    claimPreparedSourceUpload(fixture.database, {
      bytes: 5,
      now: NOW + 1,
      sha256: digest("hello"),
      sourceId: finalizing.source.sourceId,
      stagingFile: "upload-recovery",
      ...fixtureOrganizationActor,
    });

    const inspectingId = "source-inspecting";
    createPreparedSource(
      fixture.database,
      {
        createdAt: NOW,
        declaredBytes: 5,
        expiresAt: NOW + 120_000,
        id: inspectingId,
        requestDigest: "a".repeat(64),
        inputBytes: 5,
        inputSha256: digest("hello"),
        maxUploadBytes: 1_000,
        sourceFilename: "input.mp4",
        state: "inspecting",
        updatedAt: NOW,
        uploadExpiresAt: NOW + 30_000,
        organizationId: "org-1",
        createdByUserId: "user-1",
      },
      fixtureOrganizationActor,
    );
    const inspectingPaths = await Effect.runPromise(
      makeSourceStoragePaths(fixture.mediaRoot, inspectingId),
    );
    await Effect.runPromise(prepareSourceWorkspace(inspectingPaths));
    await writeFile(inspectingPaths.inputFile, "hello");

    await Effect.runPromise(fixture.service.maintain({ now: NOW + 30_000 }));

    expect(
      fixture.database.db
        .select({ id: preparedSources.id, state: preparedSources.state })
        .from(preparedSources)
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { id: finalizing.source.sourceId, state: "ready" },
        { id: inspectingId, state: "ready" },
      ]),
    );
  });
});

describe("prepared source finalization deadline", () => {
  it("keeps an in-flight finalization alive when status is read at the upload deadline", async () => {
    const fixture = await testContext(successfulInspector().service);
    const created = await Effect.runPromise(fixture.service.create(createInput()));
    claimPreparedSourceUpload(fixture.database, {
      bytes: 5,
      now: NOW + 1,
      sha256: digest("hello"),
      sourceId: created.source.sourceId,
      stagingFile: "upload-in-flight",
      ...fixtureOrganizationActor,
    });

    const status = await Effect.runPromise(
      fixture.service.status({
        correlationId: "status-request",
        now: NOW + 30_000,
        sourceId: created.source.sourceId,
        ...fixtureOrganizationActor,
      }),
    );

    expect(status).toMatchObject({
      sha256: digest("hello"),
      sourceId: created.source.sourceId,
      state: "finalizing",
      verifiedBytes: 5,
    });
    expect(status).not.toHaveProperty("upload");
    expect(
      fixture.database.db
        .select({ state: preparedSources.state })
        .from(preparedSources)
        .where(eq(preparedSources.id, created.source.sourceId))
        .get(),
    ).toEqual({ state: "finalizing" });
  });
});

const testContext = async (inspector: MediaInspector["Service"]) => {
  const directory = await mkdtemp(join(tmpdir(), "densio-source-service-"));
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
  const mediaRoot = join(directory, "media");
  const service = makePreparedSourceService(database, {
    now: () => NOW,
    inspector,
    mediaRoot,
    publicBaseUrl: "https://media.example",
    sourceTtlMs: 120_000,
    uploadTtlMs: 30_000,
  });
  return { database, mediaRoot, service };
};

const createInput = () => ({
  bytes: 5,
  correlationId: "request-1",
  filename: "input.mp4",
  idempotencyKey: "request-1",
  maxUploadBytes: 1_000,
  now: NOW,
  ...fixtureOrganizationActor,
});

const successfulInspector = () => {
  const inspectedPaths: Array<string> = [];
  const service = MediaInspector.of({
    checkCapabilities: () => Effect.die("Not expected"),
    classifyAudio: () => Effect.die("Not expected"),
    resolveTrimRange: () => Effect.die("Unexpected trim resolution"),
    resolveFrameTimestamp: () => Effect.die("Not expected"),
    inspect: (path) =>
      Effect.sync(() => {
        inspectedPaths.push(path);
        return {
          audioStreamIndexes: [1],
          displayDimensions: { height: 640, width: 360 },
          durationSeconds: 3.5,
          encodedDimensions: { height: 360, width: 640 },
          frameRate: { denominator: 1_001, framesPerSecond: 59.94005994005994, numerator: 60_000 },
          rotationDegrees: 90,
          streams: [
            { codecName: "h264", index: 0, type: "video" },
            { codecName: "aac", index: 1, type: "audio" },
          ],
          videoStreamIndex: 0,
        };
      }),
  });
  return { inspectedPaths, service };
};

const failingInspector = () =>
  MediaInspector.of({
    checkCapabilities: () => Effect.die("Not expected"),
    classifyAudio: () => Effect.die("Not expected"),
    resolveTrimRange: () => Effect.die("Unexpected trim resolution"),
    resolveFrameTimestamp: () => Effect.die("Not expected"),
    inspect: () =>
      Effect.fail(
        new MediaInspectionError({
          message: "No video stream.",
          reason: "no-video-stream",
        }),
      ),
  });

const invalidNormalizedInspector = () =>
  MediaInspector.of({
    checkCapabilities: () => Effect.die("Not expected"),
    classifyAudio: () => Effect.die("Not expected"),
    resolveTrimRange: () => Effect.die("Unexpected trim resolution"),
    resolveFrameTimestamp: () => Effect.die("Not expected"),
    inspect: () =>
      Effect.succeed({
        audioStreamIndexes: [0],
        displayDimensions: { height: 360, width: 640 },
        durationSeconds: 2,
        encodedDimensions: { height: 360, width: 640 },
        frameRate: { denominator: 1, framesPerSecond: 30, numerator: 30 },
        rotationDegrees: 0,
        streams: [
          { codecName: "h264", index: 0, type: "video" },
          { codecName: "aac", index: 0, type: "audio" },
        ],
        videoStreamIndex: 0,
      }),
  });

const stream = (value: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
