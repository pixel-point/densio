import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactAuthorizationSchema,
  ArtifactDeletedResponseSchema,
  ArtifactDescriptorSchema,
  ProblemDetailsSchema,
  successEnvelope,
} from "@densio/shared";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";

import {
  ArtifactControlUnavailable,
  makeArtifactControlService,
} from "../src/artifacts/artifact-control-service.ts";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { createOpaqueToken, formatOpaqueToken, hashTokenSecret } from "../src/auth/opaque-token.ts";
import { ArtifactUnavailable } from "../src/database/artifact-repository.ts";
import {
  authorizeOwnedArtifact,
  findGrantedArtifact,
} from "../src/database/artifact-repository.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { artifactAccessGrants, artifacts, sessions, users } from "../src/database/schema.ts";
import { makeOrganizationService } from "../src/organizations/organization-service.ts";
import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
  otherFixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { succeedCanonicalJob } from "./job-fixture.ts";
import { createArtifactControlRoutes } from "../src/routes/artifact-control.ts";
import { createArtifactRoutes } from "../src/routes/artifacts.ts";

const NOW = 1_800_000_000_000;
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("exposes artifact control repository, service, and routes", async () => {
  await expect(import("../src/database/artifact-repository.ts")).resolves.toMatchObject({
    authorizeOwnedArtifact: expect.any(Function),
    findOwnedArtifact: expect.any(Function),
    tombstoneOwnedArtifact: expect.any(Function),
  });
  await expect(import("../src/artifacts/artifact-control-service.ts")).resolves.toMatchObject({
    makeArtifactControlService: expect.any(Function),
  });
  await expect(import("../src/routes/artifact-control.ts")).resolves.toMatchObject({
    createArtifactControlRoutes: expect.any(Function),
  });
});

it("creates independent grants without persisting bearer tokens", async () => {
  const harness = await createTestHarness();
  const first = await Effect.runPromise(
    authorizeOwnedArtifact(harness.database, {
      accessTtlMs: 5_000,
      artifactId: "artifact-1",
      now: NOW,
      ...fixtureOrganizationActor,
    }),
  );
  const second = await Effect.runPromise(
    authorizeOwnedArtifact(harness.database, {
      accessTtlMs: 5_000,
      artifactId: "artifact-1",
      now: NOW,
      ...fixtureOrganizationActor,
    }),
  );
  if (first.kind !== "authorized" || second.kind !== "authorized") {
    throw new Error("Expected independent authorizations");
  }

  expect(first.token).not.toBe(second.token);
  expect(first.expiresAt).toBe(NOW + 5_000);
  const stored = harness.database.db.select().from(artifactAccessGrants).all();
  expect(stored).toHaveLength(2);
  expect(JSON.stringify(stored)).not.toContain(first.token);
  await expect(
    Effect.runPromise(
      findGrantedArtifact(harness.database, {
        artifactId: "artifact-1",
        now: NOW + 4_999,
        token: first.token,
      }),
    ),
  ).resolves.toMatchObject({ id: "artifact-1" });
  await expect(
    Effect.runPromise(
      Effect.flip(
        findGrantedArtifact(harness.database, {
          artifactId: "artifact-1",
          now: NOW + 5_000,
          token: first.token,
        }),
      ),
    ),
  ).resolves.toBeInstanceOf(ArtifactUnavailable);
  harness.database.close();
});

it("never authorizes beyond retention and hides foreign artifacts", async () => {
  const harness = await createTestHarness({ retainedUntil: NOW + 1_000 });

  const authorization = await Effect.runPromise(
    authorizeOwnedArtifact(harness.database, {
      accessTtlMs: 5_000,
      artifactId: "artifact-1",
      now: NOW,
      ...fixtureOrganizationActor,
    }),
  );
  expect(authorization).toMatchObject({ expiresAt: NOW + 1_000, kind: "authorized" });
  await expect(
    Effect.runPromise(
      authorizeOwnedArtifact(harness.database, {
        accessTtlMs: 5_000,
        artifactId: "artifact-1",
        now: NOW,
        ...otherFixtureOrganizationActor,
      }),
    ),
  ).resolves.toEqual({ kind: "not-found" });
  harness.database.close();
});

it("returns stable descriptors and reports physical retention expiry", async () => {
  const harness = await createTestHarness();
  const service = makeArtifactControlService(harness.database, {
    accessGrantTtlMs: 5_000,
    mediaRoot: harness.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
  });

  await expect(
    Effect.runPromise(
      service.get({ artifactId: "artifact-1", now: NOW, ...fixtureOrganizationActor }),
    ),
  ).resolves.toEqual({
    organizationId: "org-1",
    authorizeUrl: "https://api.densio.test/v1/organizations/org-1/artifacts/artifact-1/authorize",
    availability: "available",
    bytes: 5,
    codec: "vp9",
    deleteUrl: "https://api.densio.test/v1/organizations/org-1/artifacts/artifact-1",
    durationSeconds: 2,
    filename: "video.webm",
    height: 720,
    id: "artifact-1",
    kind: "video",
    mediaType: "video/webm",
    retainedUntil: new Date(NOW + 60_000).toISOString(),
    sha256: "a".repeat(64),
    width: 1280,
  });
  const expired = await Effect.runPromise(
    service.get({ artifactId: "artifact-1", now: NOW + 60_000, ...fixtureOrganizationActor }),
  );
  expect(expired).toMatchObject({ id: "artifact-1", availability: "expired" });
  harness.database.close();
});

it("deletes owned bytes and grants idempotently while hiding foreign resources", async () => {
  const harness = await createTestHarness();
  const service = makeArtifactControlService(harness.database, {
    accessGrantTtlMs: 5_000,
    mediaRoot: harness.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
  });
  await Effect.runPromise(
    authorizeOwnedArtifact(harness.database, {
      accessTtlMs: 5_000,
      artifactId: "artifact-1",
      now: NOW,
      ...fixtureOrganizationActor,
    }),
  );

  const first = await Effect.runPromise(
    service.delete({ artifactId: "artifact-1", now: NOW + 1, ...fixtureOrganizationActor }),
  );
  const replay = await Effect.runPromise(
    service.delete({ artifactId: "artifact-1", now: NOW + 2, ...fixtureOrganizationActor }),
  );
  expect(first).toEqual({
    organizationId: "org-1",
    artifactId: "artifact-1",
    deleted: true,
    deletedAt: new Date(NOW + 1).toISOString(),
  });
  expect(replay).toEqual(first);
  await expect(access(harness.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(harness.database.db.select().from(artifactAccessGrants).all()).toEqual([]);
  expect(
    harness.database.db.select().from(artifacts).where(eq(artifacts.id, "artifact-1")).get(),
  ).toMatchObject({ deletedAt: NOW + 1 });
  await expect(
    Effect.runPromise(
      Effect.flip(
        service.delete({
          artifactId: "artifact-1",
          now: NOW + 2,
          ...otherFixtureOrganizationActor,
        }),
      ),
    ),
  ).resolves.toEqual(new ArtifactControlUnavailable({ reason: "not-found" }));
  harness.database.close();
});

it("reconciles a tombstoned artifact whose bytes survived an interrupted deletion", async () => {
  const harness = await createTestHarness();
  await Effect.runPromise(
    authorizeOwnedArtifact(harness.database, {
      accessTtlMs: 5_000,
      artifactId: "artifact-1",
      now: NOW,
      ...fixtureOrganizationActor,
    }),
  );
  harness.database.db
    .update(artifacts)
    .set({ deletedAt: NOW + 1 })
    .where(eq(artifacts.id, "artifact-1"))
    .run();
  const service = makeArtifactControlService(harness.database, {
    accessGrantTtlMs: 5_000,
    mediaRoot: harness.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
  });

  const deletion = await Effect.runPromise(
    service.delete({ artifactId: "artifact-1", now: NOW + 2, ...fixtureOrganizationActor }),
  );

  expect(deletion.deletedAt).toBe(new Date(NOW + 1).toISOString());
  await expect(access(harness.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(harness.database.db.select().from(artifactAccessGrants).all()).toEqual([]);
  harness.database.close();
});

it("keeps a failed physical deletion retryable without touching an unsafe path", async () => {
  const harness = await createTestHarness();
  const outsidePath = join(harness.mediaRoot, "..", "outside.webm");
  await writeFile(outsidePath, "outside");
  harness.database.db
    .update(artifacts)
    .set({ path: outsidePath })
    .where(eq(artifacts.id, "artifact-1"))
    .run();
  const service = makeArtifactControlService(harness.database, {
    accessGrantTtlMs: 5_000,
    mediaRoot: harness.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
  });
  await Effect.runPromise(
    authorizeOwnedArtifact(harness.database, {
      accessTtlMs: 5_000,
      artifactId: "artifact-1",
      now: NOW,
      ...fixtureOrganizationActor,
    }),
  );

  const error = await Effect.runPromise(
    Effect.flip(
      service.delete({ artifactId: "artifact-1", now: NOW + 1, ...fixtureOrganizationActor }),
    ),
  );

  expect(error).toMatchObject({ _tag: "StorageOperationError" });
  await expect(access(outsidePath)).resolves.toBeUndefined();
  expect(harness.database.db.select().from(artifactAccessGrants).all()).toHaveLength(0);
  expect(
    harness.database.db.select().from(artifacts).where(eq(artifacts.id, "artifact-1")).get(),
  ).toMatchObject({ deletedAt: NOW + 1, deletionError: "unsafe-path" });
  harness.database.close();
});

it("authenticates descriptor, authorization, and deletion routes with exact problems", async () => {
  const harness = await createTestHarness();
  const ownerToken = seedAccess(harness.database, "user-1");
  const otherToken = seedAccess(harness.database, "user-2");
  const service = makeArtifactControlService(harness.database, {
    accessGrantTtlMs: 5_000,
    mediaRoot: harness.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
  });
  const app = new Hono();
  app.route(
    "/",
    createArtifactControlRoutes({
      organizationService: makeOrganizationService(harness.database),
      artifactService: service,
      authService: makeAuthService(
        harness.database,
        makeMagicLinkSealer("0123456789abcdef".repeat(4)),
      ),
      createCorrelationId: () => "artifact-control-request",
      now: () => NOW,
    }),
  );
  app.route(
    "/",
    createArtifactRoutes({
      createCorrelationId: () => "artifact-download-request",
      database: harness.database,
      now: () => NOW,
    }),
  );

  const anonymous = await app.request("/v1/organizations/org-1/artifacts/artifact-1");
  expect(anonymous.status).toBe(401);
  const foreign = await app.request("/v1/organizations/org-1/artifacts/artifact-1", {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(foreign.status).toBe(404);
  expect(Schema.decodeUnknownSync(ProblemDetailsSchema)(await foreign.json()).code).toBe(
    "ORGANIZATION_NOT_FOUND",
  );

  const descriptor = await app.request("/v1/organizations/org-1/artifacts/artifact-1", {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(descriptor.status).toBe(200);
  expect(descriptor.headers.get("cache-control")).toBe("no-store");
  expect(
    Schema.decodeUnknownSync(successEnvelope(ArtifactDescriptorSchema))(await descriptor.json())
      .data.id,
  ).toBe("artifact-1");

  const authorization = await app.request(
    "/v1/organizations/org-1/artifacts/artifact-1/authorize",
    {
      headers: { authorization: `Bearer ${ownerToken}` },
      method: "POST",
    },
  );
  expect(authorization.status).toBe(201);
  expect(authorization.headers.get("cache-control")).toBe("no-store");
  const authorized = Schema.decodeUnknownSync(successEnvelope(ArtifactAuthorizationSchema))(
    await authorization.json(),
  ).data;
  expect(authorized.download.url).toContain("/v1/artifacts/artifact-1/");
  const downloaded = await app.request(new URL(authorized.download.url).pathname);
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get("cache-control")).toBe("private, no-store");
  expect(await downloaded.text()).toBe("video");

  const deletion = await app.request("/v1/organizations/org-1/artifacts/artifact-1", {
    headers: { authorization: `Bearer ${ownerToken}` },
    method: "DELETE",
  });
  expect(deletion.status).toBe(200);
  expect(deletion.headers.get("cache-control")).toBe("no-store");
  expect(
    Schema.decodeUnknownSync(successEnvelope(ArtifactDeletedResponseSchema))(await deletion.json())
      .data.deleted,
  ).toBe(true);
  harness.database.close();
});

it("preserves expired descriptors while denying new authorizations", async () => {
  const harness = await createTestHarness({ retainedUntil: NOW });
  harness.database.db
    .update(artifacts)
    .set({ deletedAt: NOW })
    .where(eq(artifacts.id, "artifact-1"))
    .run();
  const ownerToken = seedAccess(harness.database, "user-1");
  const app = new Hono();
  app.route(
    "/",
    createArtifactControlRoutes({
      organizationService: makeOrganizationService(harness.database),
      artifactService: makeArtifactControlService(harness.database, {
        accessGrantTtlMs: 5_000,
        mediaRoot: harness.mediaRoot,
        publicBaseUrl: "https://api.densio.test",
      }),
      authService: makeAuthService(
        harness.database,
        makeMagicLinkSealer("0123456789abcdef".repeat(4)),
      ),
      createCorrelationId: () => "artifact-control-request",
      now: () => NOW,
    }),
  );

  const response = await app.request("/v1/organizations/org-1/artifacts/artifact-1", {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(response.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(successEnvelope(ArtifactDescriptorSchema))(await response.json()).data
      .availability,
  ).toBe("expired");
  const authorization = await app.request(
    "/v1/organizations/org-1/artifacts/artifact-1/authorize",
    {
      headers: { authorization: `Bearer ${ownerToken}` },
      method: "POST",
    },
  );
  expect(authorization.status).toBe(410);
  expect(Schema.decodeUnknownSync(ProblemDetailsSchema)(await authorization.json()).code).toBe(
    "ARTIFACT_EXPIRED",
  );
  harness.database.close();
});

it("preserves deleted descriptors while denying new authorizations", async () => {
  const harness = await createTestHarness();
  harness.database.db
    .update(artifacts)
    .set({ deletedAt: NOW })
    .where(eq(artifacts.id, "artifact-1"))
    .run();
  const service = makeArtifactControlService(harness.database, {
    accessGrantTtlMs: 5_000,
    mediaRoot: harness.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
  });

  await expect(
    Effect.runPromise(
      service.get({ artifactId: "artifact-1", now: NOW, ...fixtureOrganizationActor }),
    ),
  ).resolves.toMatchObject({ id: "artifact-1", availability: "deleted" });
  await expect(
    Effect.runPromise(
      authorizeOwnedArtifact(harness.database, {
        accessTtlMs: 5_000,
        artifactId: "artifact-1",
        now: NOW,
        ...fixtureOrganizationActor,
      }),
    ),
  ).resolves.toEqual({ kind: "not-found" });
  harness.database.close();
});

const createTestHarness = async (input: { readonly retainedUntil?: number } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "densio-artifact-control-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  migrateDatabase(database);
  const mediaRoot = join(directory, "media");
  const artifactDirectory = join(mediaRoot, "job-1", "artifacts");
  const path = join(artifactDirectory, "video.webm");
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path, "video");
  database.db
    .insert(users)
    .values([
      { createdAt: NOW, email: "owner@example.com", id: "user-1", updatedAt: NOW },
      { createdAt: NOW, email: "other@example.com", id: "user-2", updatedAt: NOW },
    ])
    .run();
  ensureOrganizationActor(database);
  ensureOrganizationActor(database, "org-2", "user-2");
  succeedCanonicalJob(
    database,
    [
      {
        codec: "vp9",
        createdAt: NOW,
        durationSeconds: 2,
        filename: "video.webm",
        height: 720,
        organizationId: "org-1",
        id: "artifact-1",
        jobId: "job-1",
        kind: "video",
        mediaType: "video/webm",
        path,
        retainedUntil: input.retainedUntil === undefined ? NOW + 60_000 : input.retainedUntil,
        sha256: "a".repeat(64),
        sizeBytes: 5,
        width: 1280,
      },
    ],
    { organizationId: "org-1", createdByUserId: "user-1" },
  );
  return { database, mediaRoot, path };
};

const seedAccess = (database: Database, userId: string) => {
  const accessToken = createOpaqueToken();
  database.db
    .insert(sessions)
    .values({
      accessExpiresAt: NOW + 60_000,
      accessTokenHash: hashTokenSecret(accessToken.secret),
      createdAt: NOW,
      familyId: `family-${userId}`,
      id: accessToken.publicId,
      refreshExpiresAt: NOW + 120_000,
      updatedAt: NOW,
      userId,
    })
    .run();
  return formatOpaqueToken(accessToken);
};
