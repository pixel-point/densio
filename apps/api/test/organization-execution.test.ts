import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { sourceBytes, sourceInspection, sourceSha256 } from "./job-fixture.ts";
import {
  jobCreditEntries,
  jobs,
  organizationMemberships,
  preparedSources,
} from "../src/database/schema.ts";
import { makeExecutionPlanService } from "../src/execution-plans/execution-plan-service.ts";
import { PLAN_ENTITLEMENTS } from "../src/auth/entitlements.ts";
import { makeSourceStoragePaths } from "../src/storage/source-workspace.ts";

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
  const mediaRoot = await mkdtemp(join(tmpdir(), "densio-org-execution-"));
  fixtures.push({ database: fixture.database, mediaRoot });
  fixture.database.db
    .insert(preparedSources)
    .values({
      id: "source-team",
      organizationId: fixture.organizationId,
      createdByUserId: "owner",
      sourceFilename: "clip.mp4",
      declaredBytes: sourceBytes.length,
      maxUploadBytes: 1000,
      inputBytes: sourceBytes.length,
      inputSha256: sourceSha256,
      inspectionJson: JSON.stringify(sourceInspection),
      state: "ready",
      requestDigest: "a".repeat(64),
      createdAt: organizationNow,
      updatedAt: organizationNow,
      expiresAt: organizationNow + 120_000,
      uploadExpiresAt: organizationNow + 30_000,
    })
    .run();
  const paths = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, "source-team"));
  await mkdir(dirname(paths.inputFile), { recursive: true });
  await writeFile(paths.inputFile, sourceBytes);
  const service = makeExecutionPlanService(fixture.database, {
    createId: randomUUID,
    createJobId: randomUUID,
    maxExtractedImages: 2000,
    mediaRoot,
    planTtlMs: 60_000,
    publicBaseUrl: "https://api.densio.test",
    resolveTrimRange: () => Effect.die("Unexpected trim resolution"),
    resolveFrameTimestamp: () => Effect.die("Unexpected frame probe"),
    toolchain: { ffmpegVersion: "7.1", ffprobeVersion: "7.1" },
    now: () => organizationNow,
    priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
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
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    now: organizationNow,
    idempotencyKey: "plan-key",
    request: { sourceId: "source-team", workflow: "extract-images" as const, options: {} },
  };
  return { ...fixture, service, input, owner, member };
};

it("shares plans and executions while recording the executor separately from the uploader", async () => {
  const fixture = await setup();
  const plan = await Effect.runPromise(fixture.service.create(fixture.input));
  expect(
    await Effect.runPromise(fixture.service.create({ ...fixture.input, ...fixture.member })),
  ).toMatchObject({
    organizationId: fixture.organizationId,
    replayed: true,
    plan: { planId: plan.plan.planId, createdByUserId: "owner" },
  });
  const execution = {
    ...fixture.member,
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    now: organizationNow,
    planId: plan.plan.planId,
    idempotencyKey: "job-key",
  };
  const job = await Effect.runPromise(fixture.service.execute(execution));
  expect(
    await Effect.runPromise(fixture.service.execute({ ...execution, ...fixture.owner })),
  ).toMatchObject({ organizationId: fixture.organizationId, jobId: job.jobId, replayed: true });
  expect(fixture.database.db.select().from(jobs).get()).toMatchObject({
    organizationId: fixture.organizationId,
    createdByUserId: "member",
    state: "queued",
  });
  expect(fixture.database.db.select().from(jobCreditEntries).all()).toEqual([
    expect.objectContaining({ organizationId: fixture.organizationId, kind: "hold" }),
  ]);
});

it("refuses cross-organization source IDs and revoked members before execution replay", async () => {
  const fixture = await setup();
  const outsider = {
    organizationId: fixture.outside.organization.id,
    userId: "outsider",
    membershipId: fixture.outside.membership.id,
  };
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.create({ ...fixture.input, ...outsider }))),
  ).toMatchObject({ _tag: "ExecutionPlanSourceUnavailable" });
  const plan = await Effect.runPromise(fixture.service.create(fixture.input));
  const execution = {
    ...fixture.member,
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    now: organizationNow,
    planId: plan.plan.planId,
    idempotencyKey: "job-key",
  };
  await Effect.runPromise(fixture.service.execute(execution));
  fixture.database.db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.id, fixture.member.membershipId))
    .run();
  expect(await Effect.runPromise(Effect.flip(fixture.service.execute(execution)))).toMatchObject({
    code: "ORGANIZATION_NOT_FOUND",
  });
});
