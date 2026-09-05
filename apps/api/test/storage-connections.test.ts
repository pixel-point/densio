import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { makeStorageConnectionService } from "../src/storage/connections/connection-service.ts";
import { makeConnectionWorker } from "../src/storage/connections/connection-worker.ts";
import { MemoryObjectStore } from "./storage-provider-fixture.ts";
import {
  storageConnections,
  storageObjectReads,
  storageObjects,
} from "../src/database/video-storage-schema.ts";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  const actor = {
    organizationId: fixture.organizationId,
    userId: "owner",
    membershipId: fixture.team.membership.id,
  };
  const config = {
    now: () => organizationNow,
    credentialKeys: { primary: "ab".repeat(32) },
    activeCredentialKey: "primary",
  };
  const service = makeStorageConnectionService(fixture.database, config);
  const request = {
    name: "Website",
    credentials: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" },
    config: {
      provider: "s3" as const,
      visibility: "public" as const,
      location: {
        endpoint: "https://s3.eu-west-1.amazonaws.com",
        region: "eu-west-1",
        bucket: "website-media",
        prefix: "uploads",
        pathStyle: true,
      },
      publicBaseUrl: "https://media.example.com",
    },
  };
  return { ...fixture, actor, service, request, config };
};

test("owners on Free can connect storage while credentials stay encrypted and out of returned data", async () => {
  const { service, actor, request, database } = setup();
  const result = await Effect.runPromise(
    service.create({ ...actor, request, idempotencyKey: "connect-one" }),
  );
  expect(result.connection.state).toBe("pending-validation");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  const row = database.db.select().from(storageConnections).get();
  expect(row?.credentialsCiphertext).not.toContain("fixture-secret");
  expect(
    (await Effect.runPromise(service.create({ ...actor, request, idempotencyKey: "connect-one" })))
      .replayed,
  ).toBe(true);
  await expect(
    Effect.runPromise(
      service.create({
        ...actor,
        request: {
          ...request,
          credentials: { ...request.credentials, secretAccessKey: "changed" },
        },
        idempotencyKey: "connect-one",
      }),
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

test("ordinary members cannot configure storage credentials", async () => {
  const { service, actor, request, member } = setup();
  await expect(
    Effect.runPromise(
      service.create({
        ...actor,
        userId: "member",
        membershipId: member.id,
        request,
        idempotencyKey: "connect-one",
      }),
    ),
  ).rejects.toMatchObject({ code: "ORGANIZATION_ACCESS_DENIED" });
});

test("connection setup rejects private network endpoints and unsafe key prefixes before persisting secrets", async () => {
  const { service, actor, request, database } = setup();
  await expect(
    Effect.runPromise(
      service.create({
        ...actor,
        request: {
          ...request,
          config: {
            ...request.config,
            location: { ...request.config.location, endpoint: "https://127.0.0.1" },
          },
        },
        idempotencyKey: "local",
      }),
    ),
  ).rejects.toMatchObject({ code: "STORAGE_ENDPOINT_REJECTED" });
  await expect(
    Effect.runPromise(
      service.create({
        ...actor,
        request: {
          ...request,
          config: {
            ...request.config,
            location: { ...request.config.location, prefix: "../other" },
          },
        },
        idempotencyKey: "prefix",
      }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(database.db.select().from(storageConnections).all()).toHaveLength(0);
});

test("validated connections exercise multipart and clean probes before accepting storage work", async () => {
  const { database, config, service, actor, request } = setup();
  const created = await Effect.runPromise(
    service.create({ ...actor, request, idempotencyKey: "connect-one" }),
  );
  const store = new MemoryObjectStore("website-media", new Map());
  const worker = makeConnectionWorker(database, {
    ...config,
    storeFactory: () => store,
    verifyAccess: async () => undefined,
    writerIdentity: "test-process",
    isWriterAlive: () => false,
  });
  await Effect.runPromise(worker.maintain());
  const result = await Effect.runPromise(
    service.get({ ...actor, connectionId: created.connection.connectionId }),
  );
  expect(result.connection.state).toBe("active");
  expect(store.objects.size).toBe(0);
  expect(store.uploads.size).toBe(0);
  expect(store.calls.some((call) => call.startsWith("complete:"))).toBe(true);
});

test("disconnect erases credentials and leaves completed customer objects intact", async () => {
  const { database, config, service, actor, request } = setup();
  const created = await Effect.runPromise(
    service.create({ ...actor, request, idempotencyKey: "connect-one" }),
  );
  const store = new MemoryObjectStore("website-media", new Map());
  const worker = makeConnectionWorker(database, {
    ...config,
    storeFactory: () => store,
    verifyAccess: async () => undefined,
    writerIdentity: "test-process",
    isWriterAlive: () => false,
  });
  await Effect.runPromise(worker.maintain());
  store.objects.set("existing-video.webm", {
    bytes: Buffer.from("video"),
    metadata: {
      mediaType: "video/webm",
      filename: "existing-video.webm",
      sha256: "a".repeat(64),
      public: true,
    },
  });
  await Effect.runPromise(
    service.operate({
      ...actor,
      connectionId: created.connection.connectionId,
      kind: "disconnect",
      idempotencyKey: "disconnect-one",
    }),
  );
  await Effect.runPromise(worker.maintain());
  expect(store.objects.has("existing-video.webm")).toBe(true);
  const row = database.db.select().from(storageConnections).get();
  expect(row?.state).toBe("disconnected");
  expect(row?.credentialsCiphertext).toBeNull();
});

test("disconnect waits for active object readers before erasing credentials", async () => {
  const { database, config, service, actor, request } = setup();
  const created = await Effect.runPromise(
    service.create({ ...actor, request, idempotencyKey: "connect-reader" }),
  );
  const store = new MemoryObjectStore("website-media", new Map());
  const workerConfig = {
    ...config,
    storeFactory: () => store,
    verifyAccess: async () => undefined,
    writerIdentity: "test-process",
    isWriterAlive: () => false,
  };
  await Effect.runPromise(makeConnectionWorker(database, workerConfig).maintain());
  database.db
    .insert(storageObjects)
    .values({
      id: "read-object",
      organizationId: actor.organizationId,
      connectionId: created.connection.connectionId,
      targetId: `connection:${created.connection.connectionId}`,
      bucketRole: "private",
      bucket: "website-media",
      objectKey: "uploads/private-video.webm",
      state: "verified",
      bytes: 5,
      sha256: "a".repeat(64),
      createdAt: organizationNow,
    })
    .run();
  database.db
    .insert(storageObjectReads)
    .values({
      id: "active-read",
      objectId: "read-object",
      organizationId: actor.organizationId,
      workerPid: process.pid,
      workerIdentity: "reader-process",
      createdAt: organizationNow,
    })
    .run();
  await Effect.runPromise(
    service.operate({
      ...actor,
      connectionId: created.connection.connectionId,
      kind: "disconnect",
      idempotencyKey: "disconnect-reader",
    }),
  );
  const readerAwareWorker = makeConnectionWorker(database, {
    ...workerConfig,
    isWriterAlive: () => true,
  });
  await Effect.runPromise(readerAwareWorker.maintain());
  const draining = database.db.select().from(storageConnections).get();
  expect(draining?.state).toBe("disabled");
  expect(draining?.credentialsCiphertext).not.toBeNull();
  database.db.delete(storageObjectReads).run();
  await Effect.runPromise(readerAwareWorker.maintain());
  const disconnected = database.db.select().from(storageConnections).get();
  expect(disconnected?.state).toBe("disconnected");
  expect(disconnected?.credentialsCiphertext).toBeNull();
});

test("validation cannot activate credentials that cannot abort an unfinished multipart upload", async () => {
  const { database, config, service, actor, request } = setup();
  const created = await Effect.runPromise(
    service.create({ ...actor, request, idempotencyKey: "no-abort" }),
  );
  class NoAbortStore extends MemoryObjectStore {
    override async abort(key: string, uploadId: string) {
      if (this.uploads.has(uploadId)) throw new Error("AccessDenied");
      return super.abort(key, uploadId);
    }
  }
  const store = new NoAbortStore("website-media", new Map());
  const worker = makeConnectionWorker(database, {
    ...config,
    storeFactory: () => store,
    verifyAccess: async () => undefined,
    writerIdentity: "test",
    isWriterAlive: () => false,
  });
  await Effect.runPromise(worker.maintain());
  const result = await Effect.runPromise(
    service.get({ ...actor, connectionId: created.connection.connectionId }),
  );
  expect(result.connection.state).toBe("error");
  expect(store.uploads.size).toBe(1);
});
