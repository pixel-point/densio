import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { storageObjectReads, storageObjects } from "../src/database/video-storage-schema.ts";
import { acquireObjectRead } from "../src/storage/objects/object-read.ts";
import type { StorageTarget } from "../src/storage/objects/object-store.ts";
import { streamGrantedVideo } from "../src/videos/video-stream.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { videoStorageFixture } from "./video-storage-fixture.ts";

afterEach(cleanupJobFixtures);

const downloadFixture = async () => {
  const fixture = await videoStorageFixture();
  await Effect.runPromise(fixture.worker.maintain());
  const variant = fixture.saved.video.variants[0]!;
  const grant = await Effect.runPromise(
    fixture.service.authorize({
      ...fixture.actor,
      videoId: fixture.saved.video.videoId,
      variantId: variant.variantId,
    }),
  );
  return {
    ...fixture,
    input: {
      variantId: variant.variantId,
      filename: variant.filename,
      token: new URL(grant.download.url).pathname.split("/").at(-2)!,
    },
  };
};

test.each(["read-failure", "changed-object"] as const)(
  "%s closes the client and releases its download lease",
  async (fault) => {
    const { database, stores, streamConfig, input } = await downloadFixture();
    const closed = stores.public.closeCalls;
    if (fault === "read-failure") stores.public.failNextRead = true;
    if (fault === "changed-object")
      stores.public.objects.forEach((object) => {
        object.bytes = Buffer.alloc(object.bytes.length);
      });
    await expect(
      Effect.runPromise(streamGrantedVideo(database, streamConfig, input)),
    ).rejects.toBeDefined();
    expect(stores.public.closeCalls).toBe(closed + 1);
    expect(database.db.select().from(storageObjectReads).all()).toHaveLength(0);
  },
);

test.each(["complete", "cancel"] as const)(
  "download %s releases the response resources once",
  async (action) => {
    const { database, stores, streamConfig, input } = await downloadFixture();
    const closed = stores.public.closeCalls;
    const response = await Effect.runPromise(streamGrantedVideo(database, streamConfig, input));
    expect(database.db.select().from(storageObjectReads).all()).toHaveLength(1);
    if (action === "complete") await response.arrayBuffer();
    if (action === "cancel") await response.body!.cancel();
    expect(database.db.select().from(storageObjectReads).all()).toHaveLength(0);
    expect(stores.public.closeCalls).toBe(closed + 1);
  },
);

test("interruption during target acquisition releases a subsequently acquired client", async () => {
  const { database, stores, streamConfig } = await downloadFixture();
  const object = database.db
    .select()
    .from(storageObjects)
    .all()
    .find((row) => row.state === "verified")!;
  const controller = new AbortController();
  const closed = stores.public.closeCalls;
  await expect(
    acquireObjectRead(
      database,
      {
        ...streamConfig,
        resolveTarget: async (id, role) => {
          controller.abort();
          return { id, role, store: stores.public };
        },
      },
      object,
      undefined,
      controller.signal,
    ),
  ).rejects.toBeDefined();
  expect(stores.public.closeCalls).toBe(closed + 1);
  expect(database.db.select().from(storageObjectReads).all()).toHaveLength(0);
});

test("interruption releases the lease while target acquisition is still pending", async () => {
  const { database, stores, streamConfig } = await downloadFixture();
  const object = database.db
    .select()
    .from(storageObjects)
    .all()
    .find((row) => row.state === "verified")!;
  const controller = new AbortController();
  const target = Promise.withResolvers<StorageTarget>();
  const started = Promise.withResolvers<void>();
  const closed = stores.public.closeCalls;
  const response = acquireObjectRead(
    database,
    {
      ...streamConfig,
      resolveTarget: () => {
        started.resolve();
        return target.promise;
      },
    },
    object,
    undefined,
    controller.signal,
  );
  await started.promise;
  controller.abort();
  const leasesAfterAbort = database.db.select().from(storageObjectReads).all();
  target.resolve({ id: object.targetId, role: object.bucketRole, store: stores.public });
  await expect(response).rejects.toBeDefined();
  expect(leasesAfterAbort).toHaveLength(0);
  expect(stores.public.closeCalls).toBe(closed + 1);
});
