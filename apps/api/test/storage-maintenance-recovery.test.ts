import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { storageObjects } from "../src/database/video-storage-schema.ts";
import { maintainStorageHealth } from "../src/storage/managed/storage-health.ts";
import { maintainManagedInventory } from "../src/storage/managed/storage-inventory.ts";
import { readVideo } from "../src/videos/video-catalog.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { videoStorageFixture } from "./video-storage-fixture.ts";

afterEach(cleanupJobFixtures);

test("health checks reach later pages even when the first page contains missing objects", async () => {
  const { database, service, actor, worker, stores, advance, config, streamConfig } =
    await videoStorageFixture();
  for (let index = 0; index < 50; index++)
    await Effect.runPromise(
      service.save({
        ...actor,
        jobId: "job-one",
        destination: { kind: "managed" },
        idempotencyKey: `page-${index}`,
      }),
    );
  await Effect.runPromise(worker.maintain());
  const objects = database.db
    .select()
    .from(storageObjects)
    .where(eq(storageObjects.state, "verified"))
    .all();
  expect(objects).toHaveLength(51);
  objects.slice(0, 50).forEach((object) => stores.public.objects.delete(object.objectKey));
  const last = objects.at(-1)!;
  advance(86_400_001);
  await Effect.runPromise(maintainStorageHealth(database, streamConfig));
  expect(
    database.db.select().from(storageObjects).where(eq(storageObjects.id, last.id)).get()
      ?.verifiedAt,
  ).toBe(config.now());
});

test("an unavailable inventory target does not prevent another target from being scanned", async () => {
  const { database, config, stores } = await videoStorageFixture();
  stores.private.objects.set("orgs/org-one/orphan", {
    bytes: Buffer.from("orphan"),
    metadata: {
      mediaType: "application/octet-stream",
      filename: "orphan",
      sha256: "",
      public: false,
    },
  });
  const inventory = {
    now: config.now,
    targets: [{ id: "r2-test", roles: ["public", "private"] as const }],
    resolveTarget: async (id: string, role: "public" | "private" | "staging") => {
      if (role === "public") throw new Error("Temporary provider failure");
      return { id, role, store: stores[role] };
    },
    purge: async () => undefined,
  };
  await Effect.runPromise(maintainManagedInventory(database, inventory));
  const { managedStorageOrphans } = await import("../src/database/video-storage-schema.ts");
  expect(database.db.select().from(managedStorageOrphans).all()).toMatchObject([
    { bucketRole: "private", objectKey: "orgs/org-one/orphan" },
  ]);
});

test("delayed health results cannot overwrite a newer visibility operation", async () => {
  const { database, actor, service, saved, worker, advance, streamConfig } =
    await videoStorageFixture();
  await Effect.runPromise(worker.maintain());
  advance(86_400_001);
  await Effect.runPromise(
    maintainStorageHealth(database, {
      ...streamConfig,
      resolveTarget: async (id, role) => {
        await Effect.runPromise(
          service.changeVisibility({
            ...actor,
            videoId: saved.video.videoId,
            visibility: "private",
            idempotencyKey: "delayed-health",
          }),
        );
        return streamConfig.resolveTarget(id, role);
      },
    }),
  );
  expect(readVideo(database, actor.organizationId, saved.video.videoId).state).toBe(
    "visibility-changing",
  );
});
