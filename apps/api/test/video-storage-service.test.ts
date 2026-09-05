import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { executionPlans } from "../src/database/schema.ts";
import { videos, storageTransfers } from "../src/database/video-storage-schema.ts";
import { makeVideoService } from "../src/videos/video-service.ts";
import {
  createJobTestContext,
  seedJobInput,
  cleanupJobFixtures,
  succeedCanonicalJob,
} from "./job-fixture.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";

afterEach(cleanupJobFixtures);
const priceIds = { basic: "price_basic", pro: "price_pro", scale: "price_scale" };
const now = 1000;
const setup = async (plan: "free" | "basic" = "basic") => {
  const fixture = await createJobTestContext();
  const bytes = Buffer.from("encoded video bytes");
  succeedCanonicalJob(
    fixture.database,
    [
      {
        id: "artifact-one",
        organizationId: "org-one",
        jobId: "job-one",
        filename: "video-vp9.webm",
        kind: "video",
        mediaType: "video/webm",
        codec: "vp9",
        path: `${fixture.mediaRoot}/video.webm`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
        createdAt: 10,
        retainedUntil: 100_000,
      },
    ],
    {
      id: "job-one",
      organizationId: "org-one",
      createdByUserId: "user-one",
      subscriptionPlan: plan,
      sourceFilename: "Homepage Hero.mov",
    },
  );
  const actor = ensureOrganizationActor(fixture.database, "org-one", "user-one");
  const service = makeVideoService(fixture.database, {
    now: () => now,
    priceIds,
    mediaRoot: fixture.mediaRoot,
    publicBaseUrl: "https://api.example.test",
    managedTargetId: "r2-test",
    managedPublicOrigin: "https://media.example.test",
  });
  return { ...fixture, service, actor };
};

test("paid saves create a public pending video with readable frozen filenames and an independent receipt", async () => {
  const { service, actor } = await setup();
  const result = await Effect.runPromise(
    service.save({
      ...actor,
      jobId: "job-one",
      destination: { kind: "managed" },
      idempotencyKey: "save-hero",
    }),
  );
  expect(result.video).toMatchObject({
    state: "storing",
    displayName: "Homepage Hero",
    filenameStem: "homepage-hero",
    visibility: "public",
  });
  expect(result.video.variants).toMatchObject([{ filename: "homepage-hero-vp9.webm" }]);
  expect(result.video.variants[0]).not.toHaveProperty("publicUrl");
  const replay = await Effect.runPromise(
    service.save({
      ...actor,
      jobId: "job-one",
      destination: { kind: "managed" },
      idempotencyKey: "save-hero",
    }),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.video.videoId).toBe(result.video.videoId);
});

test("reusing an idempotency key with another video name is rejected", async () => {
  const { service, actor } = await setup();
  const request = {
    ...actor,
    jobId: "job-one",
    destination: { kind: "managed" as const },
    idempotencyKey: "save-hero",
  };
  await Effect.runPromise(service.save(request));
  await expect(
    Effect.runPromise(service.save({ ...request, name: "Other" })),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

test("free organizations cannot create managed saves", async () => {
  const { service, actor } = await setup("free");
  await expect(
    Effect.runPromise(
      service.save({
        ...actor,
        jobId: "job-one",
        destination: { kind: "managed" },
        idempotencyKey: "save-hero",
      }),
    ),
  ).rejects.toMatchObject({ code: "STORAGE_UPGRADE_REQUIRED" });
});

test("an organization cannot save another organization's job", async () => {
  const { database, service } = await setup();
  const actor = ensureOrganizationActor(database, "org-other", "user-other");
  await expect(
    Effect.runPromise(
      service.save({
        ...actor,
        jobId: "job-one",
        destination: { kind: "managed" },
        idempotencyKey: "save-hero",
      }),
    ),
  ).rejects.toMatchObject({ code: "VIDEO_NOT_FOUND" });
});

test.each(["compress", "trim"] as const)(
  "successful %s atomically creates its requested storage work from the frozen plan",
  async (kind) => {
    const { database } = await createJobTestContext();
    const trim = { start: { kind: "frame", frame: 0 }, end: { kind: "frame", frame: 30 } };
    const resolvedTrim = {
      videoStreamIndex: 0,
      startFrame: 0,
      endFrame: 30,
      frameCount: 30,
      startPts: "0",
      endPts: "1000",
      timeBase: { numerator: 1, denominator: 1000 },
      durationSeconds: 1,
    };
    const values = seedJobInput(database, {
      id: "auto-job",
      subscriptionPlan: "basic",
      kind,
      ...(kind === "trim"
        ? {
            requestedOptionsJson: JSON.stringify({ trim, output: { codec: "vp9" } }),
            resolvedOptionsJson: JSON.stringify({
              trim: resolvedTrim,
              output: { codec: "vp9", crf: 42 },
              audio: "remove",
            }),
          }
        : {}),
    });
    const plan = database.db
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.id, values.executionPlanId))
      .get();
    if (!plan) throw new Error("Missing fixture plan");
    database.db
      .update(executionPlans)
      .set({
        snapshotJson: JSON.stringify({
          ...JSON.parse(plan.snapshotJson),
          storage: {
            destination: { kind: "managed" },
            visibility: "public",
            displayName: "Launch Hero",
            filenameStem: "launch-hero",
            targetId: "r2-test",
            publicOrigin: "https://media.example.test",
            keyPrefix: "",
            files: [{ codec: "vp9", filename: "launch-hero-vp9.webm" }],
          },
        }),
      })
      .where(eq(executionPlans.id, plan.id))
      .run();
    succeedCanonicalJob(
      database,
      [
        {
          id: "auto-artifact",
          organizationId: values.organizationId,
          jobId: values.id,
          filename: "video-vp9.webm",
          kind: "video",
          mediaType: "video/webm",
          codec: "vp9",
          path: "/temporary/video.webm",
          sha256: "b".repeat(64),
          sizeBytes: 100,
          createdAt: 2,
          retainedUntil: 100_000,
        },
      ],
      values,
    );
    expect(database.db.select().from(videos).all()).toMatchObject([
      { automaticJobId: "auto-job", state: "storing", filenameStem: "launch-hero" },
    ]);
    expect(database.db.select().from(storageTransfers).all()).toMatchObject([
      { kind: "save", state: "pending" },
    ]);
  },
);

test("manual save uses the organization storage default when destination is omitted", async () => {
  const { database, service, actor } = await setup();
  const { storageSettings } = await import("../src/database/video-storage-schema.ts");
  database.db
    .insert(storageSettings)
    .values({
      organizationId: actor.organizationId,
      destinationJson: JSON.stringify({ kind: "managed" }),
      visibility: "public",
      updatedAt: now,
    })
    .run();
  const result = await Effect.runPromise(
    service.save({ ...actor, jobId: "job-one", idempotencyKey: "default-save" }),
  );
  expect(result.video.destination).toEqual({ kind: "managed" });
});
