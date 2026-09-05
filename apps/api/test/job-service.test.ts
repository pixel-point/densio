import { access, mkdir, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
  otherFixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { makeJobService } from "../src/jobs/job-service.ts";
import { withJobWriteActivity } from "../src/jobs/job-write-activity.ts";
import { JobNotFound } from "../src/jobs/job-errors.ts";
import { makeJobStoragePaths } from "../src/storage/workspace.ts";
import { createJobTestContext, cleanupJobFixtures, seedCanonicalJob } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("exposes owned status, lookup, ordered events, and paginated summaries with legal actions", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  ensureOrganizationActor(database, "org-2", "user-2");
  const first = seedCanonicalJob(database, { id: "first", clientReference: "hero" });
  seedCanonicalJob(database, { id: "second", createdAt: 2 });
  seedCanonicalJob(database, { id: "foreign", organizationId: "org-2", createdByUserId: "user-2" });
  const service = makeJobService(database, {
    mediaRoot,
    now: () => 10,
    publicBaseUrl: "https://api.densio.test",
  });
  const query = { correlationId: "test", ...fixtureOrganizationActor };
  const page = await Effect.runPromise(service.list({ ...query, limit: 1 }));
  expect(page.jobs.map(({ id }) => id)).toEqual(["second"]);
  const next = await Effect.runPromise(
    service.list({ ...query, limit: 1, cursor: page.nextCursor ?? "" }),
  );
  expect(next.jobs.map(({ id }) => id)).toEqual(["first"]);
  expect(next.jobs[0]?.actions.map(({ kind }) => kind)).toEqual(["wait", "cancel"]);
  const status = await Effect.runPromise(service.lookup({ ...query, clientReference: "hero" }));
  expect(status).toMatchObject({
    id: "first",
    sourceId: first.sourceId,
    executionPlanId: first.executionPlanId,
    progress: { phase: "preparing", percent: 0 },
  });
  expect(status).not.toHaveProperty("upload");
  expect(status).not.toHaveProperty("progressPercent");
  expect(
    await Effect.runPromise(
      service.events({ jobId: "first", ...fixtureOrganizationActor, after: 0, limit: 10 }),
    ),
  ).toMatchObject({ events: [{ kind: "created", state: "preparing" }] });
});

it("makes foreign and missing jobs indistinguishable across read and cancel operations", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  ensureOrganizationActor(database, "org-2", "user-2");
  seedCanonicalJob(database);
  const service = makeJobService(database, {
    mediaRoot,
    now: () => 10,
    publicBaseUrl: "https://api.densio.test",
  });
  for (const jobId of ["job-1", "missing"]) {
    const input = { jobId, ...otherFixtureOrganizationActor, correlationId: "test" };
    expect(await Effect.runPromise(Effect.flip(service.status(input)))).toBeInstanceOf(JobNotFound);
    expect(
      await Effect.runPromise(Effect.flip(service.cancel({ ...input, now: 10 }))),
    ).toBeInstanceOf(JobNotFound);
    expect(
      await Effect.runPromise(
        Effect.flip(
          service.events({ jobId, ...otherFixtureOrganizationActor, after: 0, limit: 10 }),
        ),
      ),
    ).toBeInstanceOf(JobNotFound);
  }
});

it("retries workspace cleanup on idempotent cancellation while preserving the frozen receipt", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  ensureOrganizationActor(database, "org-2", "user-2");
  const job = seedCanonicalJob(database);
  const service = makeJobService(database, {
    mediaRoot,
    now: () => 10,
    publicBaseUrl: "https://api.densio.test",
  });
  const input = { jobId: job.id, ...fixtureOrganizationActor, correlationId: "test", now: 10 };
  const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, job.id));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const writer = Effect.runPromise(
    withJobWriteActivity(
      database,
      job,
      Effect.tryPromise(async () => {
        started.resolve();
        await finish.promise;
        await mkdir(paths.stagingDirectory, { recursive: true });
        await writeFile(`${paths.stagingDirectory}/residue`, "residue");
      }),
    ),
  );
  await started.promise;
  const first = await Effect.runPromise(service.cancel(input));
  expect(first).toMatchObject({
    state: "canceled",
    receipt: { execution: { attempts: 0, commands: [] }, billing: { actualCredits: 0 } },
  });
  finish.resolve();
  await writer;
  const replay = await Effect.runPromise(service.cancel({ ...input, now: 20 }));
  expect(replay).toEqual(first);
  await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
