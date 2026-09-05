import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { storageTransfers } from "../src/database/video-storage-schema.ts";
import { streamGrantedVideo } from "../src/videos/video-stream.ts";
import { readVideo } from "../src/videos/video-catalog.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { videoStorageFixture, videoExportFixture } from "./video-storage-fixture.ts";

afterEach(cleanupJobFixtures);
test("failed target acquisition must release its download lease", async () => {
  const { database, worker, service, actor, saved, streamConfig } = await videoStorageFixture();
  await Effect.runPromise(worker.maintain());
  const variant = readVideo(database, actor.organizationId, saved.video.videoId).variants[0]!;
  const grant = await Effect.runPromise(
    service.authorize({
      ...actor,
      videoId: saved.video.videoId,
      variantId: variant.variantId,
    }),
  );
  const url = new URL(grant.download.url);
  await expect(
    Effect.runPromise(
      streamGrantedVideo(
        database,
        {
          ...streamConfig,
          writerIdentity: "review",
          resolveTarget: async () => {
            throw new Error("Unavailable target");
          },
        },
        {
          variantId: variant.variantId,
          token: url.pathname.split("/").at(-2)!,
          filename: variant.filename,
        },
      ),
    ),
  ).rejects.toBeDefined();
  const { storageObjectReads } = await import("../src/database/video-storage-schema.ts");
  expect(database.db.select().from(storageObjectReads).all()).toHaveLength(0);
});

test("retrying an export after source visibility changes retains usable input", async () => {
  const { database, actor, service, saved, stores, exported, exportWorker, advance } =
    await videoExportFixture();
  stores.public.failNextRead = true;
  await Effect.runPromise(exportWorker.maintain());
  expect(readVideo(database, actor.organizationId, exported.video.videoId).state).toBe("storing");
  database.db
    .update(storageTransfers)
    .set({ nextAttemptAt: 1_000_000 })
    .where(eq(storageTransfers.id, exported.video.transferId))
    .run();
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: saved.video.videoId,
      visibility: "private",
      idempotencyKey: "review-private",
    }),
  );
  await Effect.runPromise(exportWorker.maintain());
  advance(61_000);
  await Effect.runPromise(exportWorker.maintain());
  await Effect.runPromise(exportWorker.maintain());
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe("ready");
  await Effect.runPromise(
    service.recover({
      ...actor,
      videoId: exported.video.videoId,
      action: "retry",
      idempotencyKey: "review-retry",
    }),
  );
  await Effect.runPromise(exportWorker.maintain());
  expect(readVideo(database, actor.organizationId, exported.video.videoId).state).toBe("ready");
});

test("health audit must not resurrect a forgotten video", async () => {
  const {
    database,
    actor,
    service,
    exported,
    exportWorker,
    advance,
    customer,
    resolveTarget,
    config,
  } = await videoExportFixture();
  await Effect.runPromise(exportWorker.maintain());
  await Effect.runPromise(
    service.recover({
      ...actor,
      videoId: exported.video.videoId,
      action: "forget",
      idempotencyKey: "review-forget",
    }),
  );
  customer.objects.clear();
  advance(86_400_001);
  const { maintainStorageHealth } = await import("../src/storage/managed/storage-health.ts");
  await Effect.runPromise(maintainStorageHealth(database, { now: config.now, resolveTarget }));
  expect(readVideo(database, actor.organizationId, exported.video.videoId).state).toBe("deleted");
});

test("save replay survives a changed organization storage default", async () => {
  const { service, actor } = await videoStorageFixture();
  await Effect.runPromise(
    service.updateSettings({
      ...actor,
      destination: { kind: "managed" },
      visibility: "public",
    }),
  );
  const request = { ...actor, jobId: "job-one", idempotencyKey: "review-default-save" };
  const saved = await Effect.runPromise(service.save(request));
  await Effect.runPromise(
    service.updateSettings({
      ...actor,
      destination: { kind: "temporary" },
      visibility: "public",
    }),
  );
  const replay = await Effect.runPromise(service.save(request));
  expect(replay.video.videoId).toBe(saved.video.videoId);
  expect(replay.replayed).toBe(true);
});

test("provider rejection stays recoverable in health maintenance", async () => {
  const { database, config, worker, advance } = await videoStorageFixture();
  await Effect.runPromise(worker.maintain());
  advance(86_400_001);
  const { maintainStorageHealth } = await import("../src/storage/managed/storage-health.ts");
  const { Exit } = await import("effect");
  const result = await Effect.runPromise(
    Effect.exit(
      maintainStorageHealth(database, {
        now: config.now,
        resolveTarget: async () => {
          throw new Error("Provider offline");
        },
      }),
    ),
  );
  expect(Exit.isSuccess(result)).toBe(true);
});

test("disconnect preserves a forgotten video's terminal state", async () => {
  const { database, service, actor, exported, exportWorker, config } = await videoExportFixture();
  await Effect.runPromise(exportWorker.maintain());
  await Effect.runPromise(
    service.recover({
      ...actor,
      videoId: exported.video.videoId,
      action: "forget",
      idempotencyKey: "forget-disconnect",
    }),
  );
  const { makeStorageConnectionService } =
    await import("../src/storage/connections/connection-service.ts");
  const { makeConnectionWorker } = await import("../src/storage/connections/connection-worker.ts");
  const connectionConfig = {
    now: config.now,
    credentialKeys: { primary: "ab".repeat(32) },
    activeCredentialKey: "primary",
    writerIdentity: "fixture",
    isWriterAlive: () => false,
  };
  await Effect.runPromise(
    makeStorageConnectionService(database, connectionConfig).operate({
      ...actor,
      connectionId: "customer-connection",
      kind: "disconnect",
      idempotencyKey: "disconnect-forgotten",
    }),
  );
  await Effect.runPromise(makeConnectionWorker(database, connectionConfig).maintain());
  expect(readVideo(database, actor.organizationId, exported.video.videoId).state).toBe("deleted");
});

test("disconnect drains exports using the connection as a source", async () => {
  const { database, service, actor, exported, exportWorker, config } = await videoExportFixture();
  await Effect.runPromise(exportWorker.maintain());
  const { storageConnections } = await import("../src/database/video-storage-schema.ts");
  const connection = database.db.select().from(storageConnections).get()!;
  database.db
    .insert(storageConnections)
    .values({
      ...connection,
      id: "other-connection",
      idempotencyKey: "other-connection",
    })
    .run();
  const next = await Effect.runPromise(
    service.export({
      ...actor,
      videoId: exported.video.videoId,
      connectionId: "other-connection",
      idempotencyKey: "second-export",
    }),
  );
  database.db
    .update(storageTransfers)
    .set({
      state: "uploading",
      workerPid: process.pid,
      workerIdentity: "source-export",
      leaseOwner: "export-lease",
    })
    .where(eq(storageTransfers.id, next.video.transferId))
    .run();
  const { makeStorageConnectionService } =
    await import("../src/storage/connections/connection-service.ts");
  const { makeConnectionWorker } = await import("../src/storage/connections/connection-worker.ts");
  const connectionConfig = {
    now: config.now,
    credentialKeys: { primary: "ab".repeat(32) },
    activeCredentialKey: "primary",
    writerIdentity: "connection",
    isWriterAlive: () => true,
  };
  await Effect.runPromise(
    makeStorageConnectionService(database, connectionConfig).operate({
      ...actor,
      connectionId: connection.id,
      kind: "disconnect",
      idempotencyKey: "disconnect-source",
    }),
  );
  const disconnect = makeConnectionWorker(database, connectionConfig);
  await Effect.runPromise(disconnect.maintain());
  expect(
    database.db
      .select()
      .from(storageConnections)
      .where(eq(storageConnections.id, connection.id))
      .get()?.credentialsCiphertext,
  ).not.toBeNull();
  expect(
    database.db
      .select()
      .from(storageTransfers)
      .where(eq(storageTransfers.id, next.video.transferId))
      .get()?.state,
  ).toBe("canceled");
  database.db
    .update(storageTransfers)
    .set({ workerPid: null, workerIdentity: null, leaseOwner: null })
    .where(eq(storageTransfers.id, next.video.transferId))
    .run();
  await Effect.runPromise(disconnect.maintain());
  expect(
    database.db
      .select()
      .from(storageConnections)
      .where(eq(storageConnections.id, connection.id))
      .get()?.credentialsCiphertext,
  ).toBeNull();
});

test("disabled source connections reject new exports and download grants", async () => {
  const { database, service, actor, exported, exportWorker, config } = await videoExportFixture();
  await Effect.runPromise(exportWorker.maintain());
  const { storageConnections } = await import("../src/database/video-storage-schema.ts");
  const connection = database.db.select().from(storageConnections).get()!;
  database.db
    .insert(storageConnections)
    .values({
      ...connection,
      id: "enabled-destination",
      idempotencyKey: "enabled-destination",
    })
    .run();
  const { makeStorageConnectionService } =
    await import("../src/storage/connections/connection-service.ts");
  await Effect.runPromise(
    makeStorageConnectionService(database, {
      now: config.now,
      credentialKeys: { primary: "ab".repeat(32) },
      activeCredentialKey: "primary",
    }).operate({
      ...actor,
      connectionId: connection.id,
      kind: "disable",
      idempotencyKey: "disable-source",
    }),
  );
  await expect(
    Effect.runPromise(
      service.export({
        ...actor,
        videoId: exported.video.videoId,
        connectionId: "enabled-destination",
        idempotencyKey: "disabled-source-export",
      }),
    ),
  ).rejects.toMatchObject({ code: "STORAGE_CONNECTION_UNAVAILABLE" });
  await expect(
    Effect.runPromise(
      service.authorize({
        ...actor,
        videoId: exported.video.videoId,
        variantId: exported.video.variants[0]!.variantId,
      }),
    ),
  ).rejects.toBeDefined();
});

test("source deletion waits for a retrying export to consume its input", async () => {
  const { database, actor, service, saved, stores, exported, exportWorker, advance, customer } =
    await videoExportFixture();
  stores.public.failNextRead = true;
  await Effect.runPromise(exportWorker.maintain());
  database.db
    .update(storageTransfers)
    .set({ nextAttemptAt: 1_000_000 })
    .where(eq(storageTransfers.id, exported.video.transferId))
    .run();
  await Effect.runPromise(
    service.remove({
      ...actor,
      videoId: saved.video.videoId,
      idempotencyKey: "delete-export-source",
    }),
  );
  await Effect.runPromise(exportWorker.maintain());
  expect(stores.public.objects.size).toBe(1);
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe("deleting");
  await Effect.runPromise(
    service.recover({
      ...actor,
      videoId: exported.video.videoId,
      action: "retry",
      idempotencyKey: "retry-before-delete",
    }),
  );
  await Effect.runPromise(exportWorker.maintain());
  expect(readVideo(database, actor.organizationId, exported.video.videoId).state).toBe("ready");
  expect(customer.objects.size).toBe(1);
  advance(1001);
  await Effect.runPromise(exportWorker.maintain());
  advance(61_000);
  await Effect.runPromise(exportWorker.maintain());
  expect(stores.public.objects.size).toBe(0);
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe("deleted");
});
