import { runAdminCommand } from "../src/admin/admin-command.ts";
import { eq } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { storageObjects, storageTransfers } from "../src/database/video-storage-schema.ts";
import {
  inspectUncertainUploads,
  reconcileUncertainUpload,
} from "../src/storage/recovery/storage-recovery.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { videoStorageFixture } from "./video-storage-fixture.ts";

afterEach(cleanupJobFixtures);
const setup = async () => {
  const fixture = await videoStorageFixture();
  const transfer = fixture.database.db.select().from(storageTransfers).get()!;
  fixture.database.db
    .insert(storageObjects)
    .values({
      id: "uncertain",
      organizationId: fixture.actor.organizationId,
      videoId: transfer.videoId,
      transferId: transfer.id,
      targetId: "r2-test",
      bucketRole: "public",
      bucket: "public",
      objectKey: "uncertain-key",
      state: "creating",
      bytes: 100,
      sha256: "a".repeat(64),
      createdAt: 1000,
    })
    .run();
  const recover = () =>
    reconcileUncertainUpload(fixture.database, fixture.actor.organizationId, "uncertain", {
      ...fixture.streamConfig,
      isWriterAlive: () => false,
    });
  const multipart = () =>
    fixture.stores.public.createMultipart("uncertain-key", {
      mediaType: "video/webm",
      filename: "video.webm",
      sha256: "a".repeat(64),
      public: true,
    });
  return { ...fixture, transfer, recover, multipart };
};
test.each([0, 1, 2])(
  "recovery adopts only one exact-key multipart session (%i sessions)",
  async (count) => {
    const fixture = await setup();
    const ids = await Promise.all(Array.from({ length: count }, fixture.multipart));
    fixture.stores.public.calls.length = 0;
    expect(inspectUncertainUploads(fixture.database, fixture.actor.organizationId)).toHaveLength(1);
    expect(await fixture.recover()).toMatchObject({
      outcome: count === 1 ? "adopted" : count === 0 ? "no-evidence" : "ambiguous",
      multipartCount: count,
    });
    expect(fixture.database.db.select().from(storageObjects).get()).toMatchObject({
      state: count === 1 ? "uploading" : "creating",
      uploadId: count === 1 ? ids[0] : null,
    });
    expect(fixture.stores.public.calls).toEqual([]);
    expect(fixture.stores.public.closeCalls).toBe(1);
  },
);
test("a completed object is left for normal content verification", async () => {
  const fixture = await setup();
  await fixture.multipart();
  fixture.stores.public.objects.set("uncertain-key", {
    bytes: Buffer.from("unverified"),
    metadata: { mediaType: "video/webm", filename: "video.webm", sha256: "", public: true },
  });
  expect(await fixture.recover()).toMatchObject({ outcome: "object-present" });
  expect(fixture.database.db.select().from(storageObjects).get()?.uploadId).toBeNull();
});
test("missing process identity with a claimed lease blocks recovery", async () => {
  const fixture = await setup();
  fixture.database.db
    .update(storageTransfers)
    .set({ leaseOwner: "unknown-writer" })
    .where(eq(storageTransfers.id, fixture.transfer.id))
    .run();
  expect(await fixture.recover()).toMatchObject({ outcome: "writer-active" });
  expect(fixture.stores.public.closeCalls).toBe(0);
});
test("a lease claimed during provider observation prevents adoption", async () => {
  const fixture = await setup();
  await fixture.multipart();
  const original = fixture.stores.public.listMultipart.bind(fixture.stores.public);
  fixture.stores.public.listMultipart = async (key) => {
    fixture.database.db
      .update(storageTransfers)
      .set({ leaseOwner: "new-writer" })
      .where(eq(storageTransfers.id, fixture.transfer.id))
      .run();
    return original(key);
  };
  expect(await fixture.recover()).toMatchObject({ outcome: "changed" });
  expect(fixture.database.db.select().from(storageObjects).get()?.uploadId).toBeNull();
});
test("provider errors are sanitized and close the provider client", async () => {
  const fixture = await setup();
  fixture.stores.public.listMultipart = async () => {
    throw new Error("secret credential URL");
  };
  const result = await fixture.recover();
  expect(result).toMatchObject({ outcome: "provider-unavailable" });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(fixture.stores.public.closeCalls).toBe(1);
});
test("recovery is organization scoped and refuses configuration drift", async () => {
  const fixture = await setup();
  expect(
    await reconcileUncertainUpload(
      fixture.database,
      "another-org",
      "uncertain",
      fixture.streamConfig,
    ),
  ).toMatchObject({ outcome: "not-found" });
  fixture.database.db.update(storageObjects).set({ bucket: "old-bucket" }).run();
  expect(await fixture.recover()).toMatchObject({ outcome: "target-mismatch" });
});

test("a live writer on a newer deletion transfer blocks adoption of an older object", async () => {
  const fixture = await setup();
  await fixture.multipart();
  fixture.database.db
    .insert(storageTransfers)
    .values({
      ...fixture.transfer,
      id: "new-delete",
      kind: "delete",
      idempotencyKey: "new-delete",
      leaseOwner: "deletion-owner",
      workerPid: process.pid,
      workerIdentity: "live-writer",
    })
    .run();
  const result = await reconcileUncertainUpload(
    fixture.database,
    fixture.actor.organizationId,
    "uncertain",
    { ...fixture.streamConfig, isWriterAlive: () => true },
  );
  expect(result).toMatchObject({ outcome: "writer-active" });
  expect(fixture.database.db.select().from(storageObjects).get()?.uploadId).toBeNull();
});

test("a proven exited writer permits adoption without clearing its durable operation", async () => {
  const fixture = await setup();
  await fixture.multipart();
  fixture.database.db
    .update(storageTransfers)
    .set({ workerPid: 12345, workerIdentity: "exited-process", leaseOwner: "old-owner" })
    .run();
  expect(await fixture.recover()).toMatchObject({ outcome: "adopted" });
  expect(fixture.database.db.select().from(storageTransfers).get()?.leaseOwner).toBe("old-owner");
});

test("unrelated multipart keys cannot supply creation evidence", async () => {
  const fixture = await setup();
  fixture.stores.public.listMultipart = async () => [{ key: "another-key", uploadId: "unrelated" }];
  expect(await fixture.recover()).toMatchObject({ outcome: "no-evidence", multipartCount: 0 });
});

test("admin inspection is offline and reconciliation emits an operator observation", async () => {
  const fixture = await setup();
  const dependencies = { grantedBy: "test-operator", now: () => 1000 };
  const inspected = await runAdminCommand(
    fixture.database,
    ["storage", "inspect", fixture.actor.organizationId],
    dependencies,
  );
  expect(inspected).toMatchObject({
    exitCode: 0,
    output: { operator: "test-operator", objects: [{ objectId: "uncertain" }] },
  });
  await fixture.multipart();
  const result = await runAdminCommand(
    fixture.database,
    ["storage", "reconcile", fixture.actor.organizationId, "uncertain"],
    { ...dependencies, storage: fixture.streamConfig },
  );
  expect(result).toMatchObject({
    exitCode: 0,
    output: {
      outcome: "adopted",
      operator: "test-operator",
      observedAt: "1970-01-01T00:00:01.000Z",
    },
  });
  expect(JSON.stringify(result)).not.toContain("uploadId");
});
