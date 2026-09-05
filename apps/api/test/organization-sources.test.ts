import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  organizationMemberships,
  preparedSources,
  sourceWriteActivities,
} from "../src/database/schema.ts";
import { reapStoppedSourceWriters } from "../src/sources/source-write-activity.ts";
import { writerProcessIdentity } from "../src/services/writer-process.ts";
import { makePreparedSourceService } from "../src/sources/prepared-source-service.ts";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { makeSourceStoragePaths } from "../src/storage/source-workspace.ts";
import { makeOrganizationDeletionService } from "../src/organizations/organization-deletion-service.ts";
import { unusedStripeGateway } from "./unused-stripe-gateway.ts";

const fixtures: {
  database: ReturnType<typeof organizationFixture>["database"];
  mediaRoot: string;
}[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ database, mediaRoot }) => {
      database.close();
      await rm(mediaRoot, { recursive: true, force: true });
    }),
  );
});
const setup = async () => {
  const fixture = organizationFixture();
  const mediaRoot = await mkdtemp(join(tmpdir(), "densio-org-sources-"));
  fixtures.push({ database: fixture.database, mediaRoot });
  const service = makePreparedSourceService(fixture.database, {
    inspector: {
      inspect: () => Effect.die("Unexpected inspection"),
    },
    mediaRoot,
    publicBaseUrl: "https://api.densio.test",
    sourceTtlMs: 120_000,
    uploadTtlMs: 30_000,
    now: () => organizationNow,
  });
  const owner = {
    organizationId: fixture.organizationId,
    userId: "owner",
    membershipId: fixture.team.membership.id,
  };
  const member = {
    organizationId: fixture.organizationId,
    userId: "member",
    membershipId: fixture.member.id,
  };
  const input = {
    ...owner,
    bytes: 5,
    filename: "clip.mp4",
    idempotencyKey: "upload-1",
    maxUploadBytes: 1000,
    now: organizationNow,
    correlationId: "source-test",
  };
  return { ...fixture, mediaRoot, service, input, owner, member };
};

it("shares one upload identity with teammates and keeps creator provenance", async () => {
  const fixture = await setup();
  const first = await Effect.runPromise(fixture.service.create(fixture.input));
  const replay = await Effect.runPromise(
    fixture.service.create({ ...fixture.input, ...fixture.member }),
  );
  expect(replay).toMatchObject({
    organizationId: fixture.organizationId,
    replayed: true,
    source: {
      sourceId: first.source.sourceId,
      organizationId: fixture.organizationId,
      createdByUserId: "owner",
    },
  });
  expect(first.source.state === "awaiting-upload" && first.source.upload.url).toContain(
    `/v1/organizations/${fixture.organizationId}/sources/`,
  );
  expect(
    await Effect.runPromise(
      fixture.service.list({ ...fixture.member, now: organizationNow, correlationId: "list" }),
    ),
  ).toMatchObject({
    organizationId: fixture.organizationId,
    sources: [expect.objectContaining({ sourceId: first.source.sourceId })],
  });
});

it("reaps persisted writers from a previous process incarnation, never a live writer by age", async () => {
  const fixture = await setup();
  const source = await Effect.runPromise(fixture.service.create(fixture.input));
  fixture.database.db
    .insert(sourceWriteActivities)
    .values([
      {
        id: "old",
        sourceId: source.source.sourceId,
        organizationId: fixture.organizationId,
        processId: process.pid,
        processIdentity: "previous-process-at-the-same-pid",
        createdAt: 0,
      },
      {
        id: "live",
        sourceId: source.source.sourceId,
        organizationId: fixture.organizationId,
        processId: process.pid,
        processIdentity: writerProcessIdentity(process.pid),
        createdAt: 0,
      },
    ])
    .run();
  await Effect.runPromise(reapStoppedSourceWriters(fixture.database));
  expect(
    fixture.database.db.select({ id: sourceWriteActivities.id }).from(sourceWriteActivities).all(),
  ).toEqual([{ id: "live" }]);
});

it("checks membership before idempotency replay and rejects cross-organization references", async () => {
  const fixture = await setup();
  const first = await Effect.runPromise(fixture.service.create(fixture.input));
  fixture.database.db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.id, fixture.member.membershipId))
    .run();
  expect(
    await Effect.runPromise(
      Effect.flip(fixture.service.create({ ...fixture.input, ...fixture.member })),
    ),
  ).toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  expect(
    await Effect.runPromise(
      Effect.flip(
        fixture.service.status({
          organizationId: fixture.outside.organization.id,
          userId: "outsider",
          membershipId: fixture.outside.membership.id,
          sourceId: first.source.sourceId,
          now: organizationNow,
          correlationId: "cross-org",
        }),
      ),
    ),
  ).toMatchObject({ _tag: "SourceNotFound" });
});

it("rechecks membership after streaming and removes rejected staged bytes", async () => {
  const fixture = await setup();
  const first = await Effect.runPromise(fixture.service.create(fixture.input));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      fixture.database.db
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.id, fixture.member.membershipId))
        .run();
      controller.enqueue(new TextEncoder().encode("hello"));
      controller.close();
    },
  });
  expect(
    await Effect.runPromise(
      Effect.flip(
        fixture.service.upload({
          ...fixture.member,
          sourceId: first.source.sourceId,
          body,
          now: organizationNow,
          correlationId: "removed-upload",
        }),
      ),
    ),
  ).toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  expect(fixture.database.db.select().from(preparedSources).get()?.state).toBe("awaiting-upload");
  const paths = await Effect.runPromise(
    makeSourceStoragePaths(fixture.mediaRoot, first.source.sourceId),
  );
  expect(await readdir(paths.stagingDirectory)).toEqual([]);
});

it("keeps closure blocked after source deletion while an upload writer is still alive", async () => {
  const fixture = await setup();
  const source = await Effect.runPromise(fixture.service.create(fixture.input));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // Pulling occurs after a file has been opened, not merely when constructed.
        started.resolve();
        await finish.promise;
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const upload = Effect.runPromise(
    Effect.result(
      fixture.service.upload({
        ...fixture.member,
        sourceId: source.source.sourceId,
        body,
        now: organizationNow,
        correlationId: "streaming",
      }),
    ),
  );
  await started.promise;
  await Effect.runPromise(
    fixture.service.delete({
      ...fixture.owner,
      sourceId: source.source.sourceId,
      now: organizationNow,
    }),
  );
  const deletion = makeOrganizationDeletionService(fixture.database, unusedStripeGateway, {
    mediaRoot: fixture.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
    now: () => organizationNow,
  });
  const blocked = await Effect.runPromise(
    Effect.result(
      deletion.request({
        actor: fixture.owner,
        correlationId: "closure",
      }),
    ),
  );
  finish.resolve();
  await upload;
  expect(blocked).toMatchObject({
    failure: {
      code: "ORGANIZATION_DELETION_BLOCKED",
      details: { blockers: [{ kind: "uploads", count: 1 }] },
    },
  });
  await Effect.runPromise(deletion.request({ actor: fixture.owner, correlationId: "closure" }));
  await Effect.runPromise(deletion.maintain({ now: organizationNow + 1 }));
  expect(
    await Effect.runPromise(deletion.request({ actor: fixture.owner, correlationId: "done" })),
  ).toMatchObject({ state: "deleted" });
});
