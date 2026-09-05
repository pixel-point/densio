import { createHash } from "node:crypto";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { makeSourceUploadService } from "../src/storage/uploads/source-upload-service.ts";
import { makeSourceUploadWorker } from "../src/storage/uploads/source-upload-worker.ts";
import { makePreparedSourceService } from "../src/sources/prepared-source-service.ts";
import { makeStorageConnectionService } from "../src/storage/connections/connection-service.ts";
import { makeConnectionWorker } from "../src/storage/connections/connection-worker.ts";
import { organizationMemberships, preparedSources } from "../src/database/schema.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { sourceObjectUploads, storageObjects } from "../src/database/video-storage-schema.ts";
import { createJobTestContext, cleanupJobFixtures } from "./job-fixture.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";
import { MemoryObjectStore } from "./storage-provider-fixture.ts";

afterEach(cleanupJobFixtures);
const setup = async () => {
  const { database, mediaRoot } = await createJobTestContext();
  const actor = ensureOrganizationActor(database, "org-upload", "user-upload");
  const store = new MemoryObjectStore("private-stage", new Map());
  const connectionsConfig = {
    now: () => 1000,
    credentialKeys: { primary: "ab".repeat(32) },
    activeCredentialKey: "primary",
    storeFactory: () => store,
    verifyAccess: async () => undefined,
    writerIdentity: "test",
    isWriterAlive: () => false,
  };
  const connection = await Effect.runPromise(
    makeStorageConnectionService(database, connectionsConfig).create({
      ...actor,
      idempotencyKey: "connect",
      request: {
        name: "Website",
        config: {
          provider: "s3",
          visibility: "private",
          location: {
            endpoint: "https://objects.example.test",
            bucket: store.bucket,
            region: "test",
            prefix: "",
            pathStyle: true,
          },
          staging: {
            endpoint: "https://objects.example.test",
            bucket: store.bucket,
            region: "test",
            prefix: "",
            pathStyle: true,
          },
        },
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      },
    }),
  );
  await Effect.runPromise(makeConnectionWorker(database, connectionsConfig).maintain());
  const inspector = MediaInspector.of({
    checkCapabilities: () => Effect.die("unused"),
    classifyAudio: () => Effect.die("unused"),
    resolveTrimRange: () => Effect.die("Unexpected trim resolution"),
    resolveFrameTimestamp: () => Effect.die("unused"),
    inspect: () =>
      Effect.succeed({
        audioStreamIndexes: [],
        displayDimensions: { height: 360, width: 640 },
        encodedDimensions: { height: 360, width: 640 },
        durationSeconds: 2,
        frameRate: { denominator: 1, numerator: 30, framesPerSecond: 30 },
        rotationDegrees: 0,
        videoStreamIndex: 0,
        streams: [{ codecName: "h264", index: 0, type: "video" }],
      }),
  });
  const sourceService = makePreparedSourceService(database, {
    now: () => 1000,
    inspector,
    mediaRoot,
    publicBaseUrl: "https://api.example.test",
    sourceTtlMs: 86_400_000,
    uploadTtlMs: 3_600_000,
  });
  const config = {
    ...connectionsConfig,
    sourceService,
    sourceTtlMs: 86_400_000,
    uploadTtlMs: 3_600_000,
    publicBaseUrl: "https://api.example.test",
    resolveTarget: async (id: string) => ({ id, role: "staging" as const, store }),
  };
  const service = makeSourceUploadService(database, config);
  const worker = makeSourceUploadWorker(database, config);
  return {
    database,
    actor,
    store,
    config,
    service,
    worker,
    sourceService,
    connectionId: connection.connection.connectionId,
  };
};
test("customer multipart commit verifies and inspects source bytes before marking the source ready", async () => {
  const { database, actor, store, service, worker, sourceService, connectionId } = await setup();
  const bytes = Buffer.from("source movie");
  const created = await Effect.runPromise(
    service.create({
      ...actor,
      filename: "Hero.mov",
      bytes: bytes.length,
      uploadStorage: connectionId,
      maxUploadBytes: 1000,
      idempotencyKey: "upload",
      correlationId: "test",
      now: 1000,
    }),
  );
  await Effect.runPromise(worker.maintain());
  const session = database.db.select().from(sourceObjectUploads).get()!;
  const object = database.db
    .select()
    .from(storageObjects)
    .where(eq(storageObjects.id, session.objectId))
    .get()!;
  await store.uploadPart(object.objectKey, object.uploadId!, 1, bytes, bytes.length);
  await Effect.runPromise(service.commit({ ...actor, sourceId: created.source.sourceId }));
  await Effect.runPromise(worker.maintain());
  const ready = await Effect.runPromise(
    sourceService.status({
      ...actor,
      sourceId: created.source.sourceId,
      correlationId: "test",
      now: 1000,
    }),
  );
  expect(ready).toMatchObject({
    state: "ready",
    verifiedBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(store.objects.size).toBe(0);
  expect(database.db.select().from(sourceObjectUploads).get()?.state).toBe("ready");
});

const createSource = (fixture: Awaited<ReturnType<typeof setup>>, key: string) =>
  Effect.runPromise(
    fixture.service.create({
      ...fixture.actor,
      filename: "Hero.mov",
      bytes: 12,
      uploadStorage: fixture.connectionId,
      maxUploadBytes: 1000,
      idempotencyKey: key,
      correlationId: "test",
      now: 1000,
    }),
  );

test("limits unfinished direct uploads per organization without breaking idempotent replay", async () => {
  const fixture = await setup();
  for (const key of ["one", "two", "three", "four"]) await createSource(fixture, key);
  expect((await createSource(fixture, "one")).replayed).toBe(true);
  await expect(createSource(fixture, "five")).rejects.toMatchObject({
    code: "STORAGE_UPLOAD_LIMIT_EXCEEDED",
  });
});

test("membership revocation expires direct uploads and cleans provider sessions", async () => {
  const fixture = await setup();
  const created = await createSource(fixture, "revoke");
  await Effect.runPromise(fixture.worker.maintain());
  await Effect.runPromise(
    fixture.service.commit({ ...fixture.actor, sourceId: created.source.sourceId }),
  );
  fixture.database.db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.id, fixture.actor.membershipId))
    .run();
  await Effect.runPromise(fixture.worker.maintain());
  expect(fixture.database.db.select().from(sourceObjectUploads).get()?.state).toBe("expired");
  expect(fixture.store.uploads.size).toBe(0);
  expect(fixture.database.db.select().from(preparedSources).get()?.state).toBe("expired");
});

test("an invalid committed multipart inventory fails the source as well as its session", async () => {
  const fixture = await setup();
  const created = await createSource(fixture, "invalid");
  await Effect.runPromise(fixture.worker.maintain());
  await Effect.runPromise(
    fixture.service.commit({ ...fixture.actor, sourceId: created.source.sourceId }),
  );
  await Effect.runPromise(fixture.worker.maintain());
  expect(fixture.database.db.select().from(sourceObjectUploads).get()?.state).toBe("failed");
  expect(fixture.database.db.select().from(preparedSources).get()?.state).toBe("failed");
});
