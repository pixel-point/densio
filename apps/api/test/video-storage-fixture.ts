import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { makeVideoService } from "../src/videos/video-service.ts";
import { makeStorageWorker } from "../src/storage/transfers/storage-worker.ts";
import { storageConnections } from "../src/database/video-storage-schema.ts";
import { createJobTestContext, succeedCanonicalJob } from "./job-fixture.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";
import { MemoryObjectStore } from "./storage-provider-fixture.ts";

export const videoStorageFixture = async () => {
  const fixture = await createJobTestContext();
  const bytes = Buffer.from("encoded video bytes");
  await mkdir(fixture.mediaRoot, { recursive: true });
  const path = `${fixture.mediaRoot}/video.webm`;
  await writeFile(path, bytes);
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
        path,
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
      subscriptionPlan: "basic",
      sourceFilename: "Homepage Hero.mov",
    },
  );
  const actor = ensureOrganizationActor(fixture.database, "org-one", "user-one");
  let now = 1000;
  const config = {
    now: () => now,
    priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
    mediaRoot: fixture.mediaRoot,
    publicBaseUrl: "https://api.example.test",
    managedTargetId: "r2-test",
    managedPublicOrigin: "https://media.example.test",
  };
  const peers = new Map<string, MemoryObjectStore>();
  const stores = {
    public: new MemoryObjectStore("public", peers),
    private: new MemoryObjectStore("private", peers),
    staging: new MemoryObjectStore("staging", peers),
  };
  const service = makeVideoService(fixture.database, config);
  const saved = await Effect.runPromise(
    service.save({
      ...actor,
      jobId: "job-one",
      destination: { kind: "managed" },
      idempotencyKey: "save-hero",
    }),
  );
  const streamConfig = {
    ...config,
    resolveTarget: async (_targetId: string, role: "public" | "private" | "staging") => ({
      id: "r2-test",
      role,
      store: stores[role],
      publicOrigin: config.managedPublicOrigin,
    }),
    verifyPublic: async () => undefined,
    purge: async () => undefined,
  };
  const worker = makeStorageWorker(fixture.database, {
    ...streamConfig,
    writerIdentity: "test-process",
    isWriterAlive: () => false,
  });
  return {
    ...fixture,
    actor,
    config,
    stores,
    service,
    saved,
    streamConfig,
    worker,
    bytes,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
};
export const videoExportFixture = async () => {
  const fixture = await videoStorageFixture();
  const { database, actor, config, worker, service, saved, streamConfig, stores } = fixture;
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
  const customer = new MemoryObjectStore("customer-public", new Map());
  const exported = await Effect.runPromise(
    service.export({
      ...actor,
      videoId: saved.video.videoId,
      connectionId: "customer-connection",
      idempotencyKey: "export-review",
    }),
  );
  const resolveTarget = async (id: string, role: "public" | "private" | "staging") => ({
    id,
    role,
    store: id.startsWith("connection:") ? customer : stores[role],
    publicOrigin: id.startsWith("connection:")
      ? "https://customer.example.test"
      : "https://media.example.test",
  });
  const exportWorker = makeStorageWorker(database, {
    ...streamConfig,
    resolveTarget,
    writerIdentity: "review",
    isWriterAlive: () => true,
  });
  return { ...fixture, customer, exported, exportWorker, resolveTarget };
};
