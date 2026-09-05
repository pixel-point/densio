import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { makeStorageWorker } from "../src/storage/transfers/storage-worker.ts";
import { storageFailure } from "../src/storage/storage-errors.ts";
import { readVideo } from "../src/videos/video-catalog.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { videoStorageFixture } from "./video-storage-fixture.ts";

afterEach(cleanupJobFixtures);

test.each(["save", "republish"])(
  "%s clears cached missing responses before advertising public delivery",
  async (operation) => {
    const fixture = await videoStorageFixture();
    const { database, actor, service, saved, stores, worker, advance, bytes, streamConfig } =
      fixture;
    if (operation === "republish") {
      await Effect.runPromise(worker.maintain());
      await Effect.runPromise(
        service.changeVisibility({
          ...actor,
          videoId: saved.video.videoId,
          visibility: "private",
          idempotencyKey: "private",
        }),
      );
      await Effect.runPromise(worker.maintain());
      advance(61_000);
      await Effect.runPromise(worker.maintain());
      await Effect.runPromise(
        service.changeVisibility({
          ...actor,
          videoId: saved.video.videoId,
          visibility: "public",
          idempotencyKey: "public",
        }),
      );
    }
    const url = `https://media.example.test/orgs/org-one/videos/${saved.video.videoId}/homepage-hero-vp9.webm`;
    const cache = new Map<string, Buffer | null>();
    const readPublic = (address: string) => {
      if (!cache.has(address))
        cache.set(
          address,
          stores.public.objects.get(new URL(address).pathname.slice(1))?.bytes ?? null,
        );
      return cache.get(address);
    };
    expect(readPublic(url)).toBeNull();
    const provider = { purgeUnavailable: true };
    const deliveryWorker = makeStorageWorker(database, {
      ...streamConfig,
      writerIdentity: "cache-test",
      isWriterAlive: () => false,
      purge: async (urls) => {
        if (provider.purgeUnavailable) throw storageFailure("STORAGE_DELETION_BLOCKED");
        urls.forEach((address) => cache.delete(address));
      },
      verifyPublic: async (address, expectedBytes) => {
        if (readPublic(address)?.length !== expectedBytes)
          throw storageFailure("STORAGE_PUBLIC_DELIVERY_REQUIRED");
      },
    });
    await Effect.runPromise(deliveryWorker.maintain());
    expect(readVideo(database, actor.organizationId, saved.video.videoId).state).not.toBe("ready");
    expect(readPublic(url)).toBeNull();
    provider.purgeUnavailable = false;
    await Effect.runPromise(
      service.recover({
        ...actor,
        videoId: saved.video.videoId,
        action: "retry",
        idempotencyKey: "retry-purge",
      }),
    );
    await Effect.runPromise(deliveryWorker.maintain());
    expect(readVideo(database, actor.organizationId, saved.video.videoId)).toMatchObject({
      state: "ready",
      visibility: "public",
    });
    expect(readPublic(url)).toEqual(bytes);
  },
);
