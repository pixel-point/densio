import { videoStorageFixture } from "./video-storage-fixture.ts";
import { maintainStoragePolicy } from "../src/storage/managed/storage-retention.ts";
import { stripeSubscriptions, emailOutbox } from "../src/database/schema.ts";
import { findGrantedVideo } from "../src/videos/video-download.ts";
import { streamGrantedVideo } from "../src/videos/video-stream.ts";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { makeStorageWorker } from "../src/storage/transfers/storage-worker.ts";
import { storageUsage } from "../src/videos/storage-policy.ts";
import { readVideo } from "../src/videos/video-catalog.ts";
import {
  storageConnections,
  storageTransfers,
  videos,
} from "../src/database/video-storage-schema.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { MemoryObjectStore } from "./storage-provider-fixture.ts";

afterEach(cleanupJobFixtures);
const setup = videoStorageFixture;

test("a managed transfer stages, verifies and promotes named files before advertising public URLs", async () => {
  const { database, worker, saved, stores, config, bytes } = await setup();
  await Effect.runPromise(worker.maintain());
  const video = readVideo(database, "org-one", saved.video.videoId);
  expect(video.state).toBe("ready");
  expect(video.variants[0]?.publicUrl).toBe(
    `https://media.example.test/orgs/org-one/videos/${video.videoId}/homepage-hero-vp9.webm`,
  );
  expect(video.embedHtml).toContain("<video controls playsinline");
  expect(stores.public.objects.size).toBe(1);
  expect(stores.staging.objects.size).toBe(0);
  expect(stores.private.objects.size).toBe(0);
  expect(storageUsage(database, config, "org-one")).toMatchObject({
    usedBytes: bytes.length,
    reservedBytes: 0,
  });
  await Effect.runPromise(worker.maintain());
  expect(stores.public.calls.filter((call) => call.startsWith("complete:"))).toHaveLength(1);
});

test("an interrupted verification retains the transfer and reservation, then recovers without re-encoding", async () => {
  const { database, worker, stores, saved, config, bytes } = await setup();
  stores.staging.failNextRead = true;
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, "org-one", saved.video.videoId).state).not.toBe("ready");
  expect(storageUsage(database, config, "org-one").reservedBytes).toBe(bytes.length);
  database.db
    .update(storageTransfers)
    .set({ nextAttemptAt: 0 })
    .where(eq(storageTransfers.id, saved.video.transferId))
    .run();
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, "org-one", saved.video.videoId).state).toBe("ready");
  expect(stores.staging.calls.filter((call) => call.startsWith("complete:"))).toHaveLength(1);
});

test("capacity admission blocks the entire output set before any provider writes", async () => {
  const { database, worker, saved, stores } = await setup();
  database.db
    .update(videos)
    .set({ totalBytes: 25_000_000_001 })
    .where(eq(videos.id, saved.video.videoId))
    .run();
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, "org-one", saved.video.videoId)).toMatchObject({
    state: "storage-blocked",
    errorCode: "STORAGE_QUOTA_EXCEEDED",
  });
  expect(stores.staging.calls).toEqual([]);
});

test("public withdrawal completes before private status, and explicit republish restores identical URLs", async () => {
  const { database, worker, service, actor, stores, saved, advance } = await setup();
  await Effect.runPromise(worker.maintain());
  const initial = readVideo(database, "org-one", saved.video.videoId);
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: initial.videoId,
      visibility: "private",
      idempotencyKey: "private-one",
    }),
  );
  await Effect.runPromise(worker.maintain());
  expect(stores.public.objects.size).toBe(0);
  expect(stores.private.objects.size).toBe(1);
  expect(readVideo(database, "org-one", initial.videoId).state).toBe("visibility-changing");
  advance(61_000);
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, "org-one", initial.videoId)).toMatchObject({
    visibility: "private",
    state: "ready",
  });
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: initial.videoId,
      visibility: "public",
      idempotencyKey: "public-two",
    }),
  );
  await Effect.runPromise(worker.maintain());
  const restored = readVideo(database, "org-one", initial.videoId);
  expect(restored.variants[0]?.publicUrl).toBe(initial.variants[0]?.publicUrl);
  expect(restored.variants[0]?.sha256).toBe(initial.variants[0]?.sha256);
  expect(stores.private.objects.size).toBe(0);
});

test("deletion retains charged capacity until public origin and cached delivery are withdrawn", async () => {
  const { database, worker, service, actor, saved, config, bytes, advance } = await setup();
  await Effect.runPromise(worker.maintain());
  await Effect.runPromise(
    service.remove({ ...actor, videoId: saved.video.videoId, idempotencyKey: "delete-one" }),
  );
  await Effect.runPromise(worker.maintain());
  expect(storageUsage(database, config, "org-one").usedBytes).toBe(bytes.length);
  advance(61_000);
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, "org-one", saved.video.videoId).state).toBe("deleted");
  expect(storageUsage(database, config, "org-one").usedBytes).toBe(0);
});

test("renaming a ready video preserves its named files and existing embed URLs", async () => {
  const { database, worker, service, actor, saved } = await setup();
  await Effect.runPromise(worker.maintain());
  const initial = readVideo(database, "org-one", saved.video.videoId);
  await Effect.runPromise(
    service.rename({ ...actor, videoId: initial.videoId, name: "A new display name" }),
  );
  const renamed = readVideo(database, "org-one", initial.videoId);
  expect(renamed.displayName).toBe("A new display name");
  expect(renamed.variants).toEqual(initial.variants);
});

test("stored download grants are bound to membership and revoked by visibility changes", async () => {
  const { database, worker, service, actor, saved, advance, config } = await setup();
  await Effect.runPromise(worker.maintain());
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: saved.video.videoId,
      visibility: "private",
      idempotencyKey: "private-grant",
    }),
  );
  await Effect.runPromise(worker.maintain());
  advance(61_000);
  await Effect.runPromise(worker.maintain());
  const variantId = saved.video.variants[0]!.variantId;
  const grant = await Effect.runPromise(
    service.authorize({ ...actor, videoId: saved.video.videoId, variantId }),
  );
  const token = new URL(grant.download.url).pathname.split("/").at(-2)!;
  expect(findGrantedVideo(database, { variantId, token, now: config.now() }).video.id).toBe(
    saved.video.videoId,
  );
  expect(() =>
    findGrantedVideo(database, { variantId, token: `${token}wrong`, now: config.now() }),
  ).toThrow();
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: saved.video.videoId,
      visibility: "public",
      idempotencyKey: "revoke-grant",
    }),
  );
  expect(() => findGrantedVideo(database, { variantId, token, now: config.now() })).toThrow();
});

test("retry resumes a blocked delivery under its original deadline and does not create another video", async () => {
  const { database, worker, service, actor, saved } = await setup();
  database.db
    .update(videos)
    .set({ totalBytes: 25_000_000_001 })
    .where(eq(videos.id, saved.video.videoId))
    .run();
  await Effect.runPromise(worker.maintain());
  database.db
    .update(videos)
    .set({ totalBytes: 19 })
    .where(eq(videos.id, saved.video.videoId))
    .run();
  const retried = await Effect.runPromise(
    service.retry({ ...actor, videoId: saved.video.videoId, idempotencyKey: "retry-storage" }),
  );
  expect(retried.video.videoId).toBe(saved.video.videoId);
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe("ready");
  expect(
    (
      await Effect.runPromise(
        service.retry({ ...actor, videoId: saved.video.videoId, idempotencyKey: "retry-storage" }),
      )
    ).replayed,
  ).toBe(true);
});

test("loss of paid storage starts one 30-day grace period with notices and cancels purge after restoration", async () => {
  const { database, config, worker, saved, advance } = await setup();
  await Effect.runPromise(worker.maintain());
  database.db.update(stripeSubscriptions).set({ status: "canceled" }).run();
  await Effect.runPromise(maintainStoragePolicy(database, config));
  const first = storageUsage(database, config, "org-one");
  expect(first.graceDeadline).toBe(new Date(config.now() + 30 * 86_400_000).toISOString());
  expect(first.purgeVideoIds).toEqual([saved.video.videoId]);
  expect(readVideo(database, "org-one", saved.video.videoId).state).toBe("ready");
  advance(23 * 86_400_000);
  await Effect.runPromise(maintainStoragePolicy(database, config));
  expect(storageUsage(database, config, "org-one").graceDeadline).toBe(first.graceDeadline);
  expect(database.db.select().from(emailOutbox).all()).toHaveLength(2);
  database.db.update(stripeSubscriptions).set({ status: "active" }).run();
  await Effect.runPromise(maintainStoragePolicy(database, config));
  expect(storageUsage(database, config, "org-one").graceDeadline).toBeUndefined();
  advance(10 * 86_400_000);
  await Effect.runPromise(maintainStoragePolicy(database, config));
  expect(readVideo(database, "org-one", saved.video.videoId).state).toBe("ready");
});

test("daily object verification withdraws catalog delivery when stored bytes disappear", async () => {
  const { database, worker, stores, saved, advance, config } = await setup();
  await Effect.runPromise(worker.maintain());
  stores.public.objects.clear();
  advance(86_400_001);
  const { maintainStorageHealth } = await import("../src/storage/managed/storage-health.ts");
  await Effect.runPromise(
    maintainStorageHealth(database, {
      now: config.now,
      resolveTarget: async (_targetId: string, role: "public" | "private" | "staging") => ({
        id: "r2-test",
        role,
        store: stores[role],
      }),
    }),
  );
  expect(readVideo(database, "org-one", saved.video.videoId)).toMatchObject({
    state: "unavailable",
    errorCode: "STORAGE_OBJECT_CHANGED",
  });
});

test("managed objects remain public through grace and are deleted after the fixed deadline", async () => {
  const { database, config, worker, saved, advance, stores } = await setup();
  await Effect.runPromise(worker.maintain());
  database.db.update(stripeSubscriptions).set({ status: "canceled" }).run();
  await Effect.runPromise(maintainStoragePolicy(database, config));
  expect(stores.public.objects.size).toBe(1);
  advance(30 * 86_400_000 + 1);
  await Effect.runPromise(maintainStoragePolicy(database, config));
  expect(readVideo(database, "org-one", saved.video.videoId).state).toBe("deleting");
  await Effect.runPromise(worker.maintain());
  expect(stores.public.objects.size).toBe(0);
  advance(61_000);
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, "org-one", saved.video.videoId).state).toBe("deleted");
  expect(storageUsage(database, config, "org-one").usedBytes).toBe(0);
});

test("private download grants stream exact ranges without public cache headers", async () => {
  const { database, worker, service, actor, saved, advance, streamConfig, bytes } = await setup();
  await Effect.runPromise(worker.maintain());
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: saved.video.videoId,
      visibility: "private",
      idempotencyKey: "private-stream",
    }),
  );
  await Effect.runPromise(worker.maintain());
  advance(61_000);
  await Effect.runPromise(worker.maintain());
  const variantId = saved.video.variants[0]!.variantId;
  const grant = await Effect.runPromise(
    service.authorize({ ...actor, videoId: saved.video.videoId, variantId }),
  );
  const url = new URL(grant.download.url);
  const response = await Effect.runPromise(
    streamGrantedVideo(database, streamConfig, {
      variantId,
      token: url.pathname.split("/").at(-2)!,
      filename: saved.video.variants[0]!.filename,
      range: "bytes=1-4",
    }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-range")).toBe(`bytes 1-4/${bytes.length}`);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(1, 5));
});

test("exports verified variants to customer storage and forgets the catalog without deleting customer bytes", async () => {
  const { database, worker, service, actor, saved, stores, streamConfig, config } = await setup();
  await Effect.runPromise(worker.maintain());
  database.db
    .insert(storageConnections)
    .values({
      id: "customer-connection",
      organizationId: actor.organizationId,
      name: "Website",
      configJson: JSON.stringify({
        provider: "s3",
        visibility: "public",
        publicBaseUrl: "https://customer.example.test",
        location: {
          endpoint: "https://s3.example.test",
          region: "auto",
          bucket: "customer-public",
          prefix: "site",
          pathStyle: true,
        },
      }),
      credentialsCiphertext: "fixture",
      state: "active",
      validatedAt: config.now(),
      createdAt: config.now(),
      updatedAt: config.now(),
      idempotencyKey: "customer",
      requestDigest: "a".repeat(64),
    })
    .run();
  const peers = new Map<string, MemoryObjectStore>();
  const customer = new MemoryObjectStore("customer-public", peers);
  const exported = await Effect.runPromise(
    service.export({
      ...actor,
      videoId: saved.video.videoId,
      connectionId: "customer-connection",
      idempotencyKey: "export-one",
    }),
  );
  const exportWorker = makeStorageWorker(database, {
    ...streamConfig,
    resolveTarget: async (targetId, role) =>
      targetId.startsWith("connection:")
        ? { id: targetId, role, store: customer, publicOrigin: "https://customer.example.test" }
        : { id: targetId, role, store: stores[role], publicOrigin: "https://media.example.test" },
    writerIdentity: "test",
    isWriterAlive: () => false,
  });
  await Effect.runPromise(exportWorker.maintain());
  expect(readVideo(database, actor.organizationId, exported.video.videoId)).toMatchObject({
    state: "ready",
    visibility: "public",
  });
  expect([...customer.objects.keys()]).toEqual([
    `site/densio/${actor.organizationId}/customer-connection/videos/${exported.video.videoId}/homepage-hero-vp9.webm`,
  ]);
  await Effect.runPromise(
    service.recover({
      ...actor,
      videoId: exported.video.videoId,
      action: "forget",
      idempotencyKey: "forget-one",
    }),
  );
  expect(readVideo(database, actor.organizationId, exported.video.videoId).state).toBe("deleted");
  expect(customer.objects.size).toBe(1);
});

test("canceling an unstarted save fences it and cleans its catalog state", async () => {
  const { database, service, actor, saved, worker } = await setup();
  await Effect.runPromise(
    service.recover({
      ...actor,
      videoId: saved.video.videoId,
      action: "cancel",
      idempotencyKey: "cancel-one",
    }),
  );
  await Effect.runPromise(worker.maintain());
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe("deleted");
});

test("managed inventory quarantines unknown exact keys for 48 hours before deletion", async () => {
  const { database, stores, config, advance } = await setup();
  const key = "orgs/org-one/videos/orphan/video-vp9.webm";
  stores.public.objects.set(key, {
    bytes: Buffer.from("orphan"),
    metadata: {
      filename: "video-vp9.webm",
      mediaType: "video/webm",
      public: true,
      sha256: "a".repeat(64),
    },
  });
  const { maintainManagedInventory } = await import("../src/storage/managed/storage-inventory.ts");
  const inventoryConfig = {
    now: config.now,
    targets: [{ id: "r2-test", roles: ["public", "private", "staging"] as const }],
    resolveTarget: async (_id: string, role: "public" | "private" | "staging") => ({
      id: "r2-test",
      role,
      store: stores[role],
      publicOrigin: "https://media.example.test",
    }),
    purge: async () => undefined,
  };
  await Effect.runPromise(maintainManagedInventory(database, inventoryConfig));
  expect(stores.public.objects.has(key)).toBe(true);
  advance(49 * 3_600_000);
  await Effect.runPromise(maintainManagedInventory(database, inventoryConfig));
  expect(stores.public.objects.has(key)).toBe(false);
});

test("visibility withdrawal waits for an active private download reader", async () => {
  const { database, worker, service, actor, saved, advance, streamConfig } = await setup();
  await Effect.runPromise(worker.maintain());
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: saved.video.videoId,
      visibility: "private",
      idempotencyKey: "reader-private",
    }),
  );
  await Effect.runPromise(worker.maintain());
  advance(61_000);
  await Effect.runPromise(worker.maintain());
  const variant = readVideo(database, actor.organizationId, saved.video.videoId).variants[0]!;
  const grant = await Effect.runPromise(
    service.authorize({ ...actor, videoId: saved.video.videoId, variantId: variant.variantId }),
  );
  const url = new URL(grant.download.url);
  const response = await Effect.runPromise(
    streamGrantedVideo(
      database,
      { ...streamConfig, writerIdentity: "test", isWriterAlive: () => true },
      {
        variantId: variant.variantId,
        token: url.pathname.split("/").at(-2)!,
        filename: variant.filename,
      },
    ),
  );
  await Effect.runPromise(
    service.changeVisibility({
      ...actor,
      videoId: saved.video.videoId,
      visibility: "public",
      idempotencyKey: "reader-public",
    }),
  );
  const readerWorker = makeStorageWorker(database, {
    ...streamConfig,
    writerIdentity: "test",
    isWriterAlive: () => true,
  });
  await Effect.runPromise(readerWorker.maintain());
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe(
    "visibility-changing",
  );
  await response.arrayBuffer();
  advance(1_001);
  await Effect.runPromise(readerWorker.maintain());
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe("ready");
});
