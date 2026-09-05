import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { artifacts, jobs } from "../src/database/schema.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { makeJobService } from "../src/jobs/job-service.ts";
import { JobRepositoryError } from "../src/jobs/job-errors.ts";
import {
  createJobTestContext,
  cleanupJobFixtures,
  seedCanonicalJob,
  succeedCanonicalJob,
} from "./job-fixture.ts";

afterEach(cleanupJobFixtures);
const artifactRow = (id: string, retainedUntil: number) => ({
  organizationId: "org-1",
  id,
  jobId: "job-1",
  kind: "video" as const,
  filename: `${id}.webm`,
  path: `/media/artifacts/job-1/${id}.webm`,
  mediaType: "video/webm",
  sizeBytes: 5,
  sha256: "a".repeat(64),
  retainedUntil,
  createdAt: 5,
});

it("returns stable results and immutable evidence separately from changing inventory", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  ensureOrganizationActor(database, "org-2", "user-2");
  const job = succeedCanonicalJob(database, [
    artifactRow("available", 1000),
    artifactRow("deleted", 1000),
    artifactRow("expired", 10),
  ]);
  database.db.update(artifacts).set({ deletedAt: 20 }).where(eq(artifacts.id, "deleted")).run();
  const service = makeJobService(database, {
    mediaRoot,
    now: () => 30,
    publicBaseUrl: "https://api.densio.test",
  });
  const status = await Effect.runPromise(
    service.status({ jobId: job.id, ...fixtureOrganizationActor, correlationId: "test" }),
  );
  expect(status).toMatchObject({
    state: "succeeded",
    artifacts: [
      { id: "available", availability: "available" },
      { id: "deleted", availability: "deleted" },
      { id: "expired", availability: "expired" },
    ],
    result: { kind: "compress", artifactIds: ["available", "deleted", "expired"] },
    receipt: JSON.parse(job.receiptJson ?? "{}"),
  });
  expect(status.actions).toEqual([
    expect.objectContaining({
      kind: "authorize-artifacts",
      url: "https://api.densio.test/v1/organizations/org-1/artifacts/available/authorize",
    }),
    expect.objectContaining({ kind: "materialize" }),
  ]);
  expect(database.db.select().from(jobs).get()?.receiptJson).toBe(job.receiptJson);
});

it("does not advertise artifact actions when no output is retained", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  ensureOrganizationActor(database, "org-2", "user-2");
  succeedCanonicalJob(database, [artifactRow("expired", 10)]);
  const service = makeJobService(database, {
    mediaRoot,
    now: () => 20,
    publicBaseUrl: "https://api.densio.test",
  });
  const page = await Effect.runPromise(
    service.list({ ...fixtureOrganizationActor, correlationId: "test", limit: 10 }),
  );
  expect(page.jobs[0]).toMatchObject({ state: "succeeded", actions: [] });
});

it("requires actual terminal evidence instead of synthesizing a partial receipt", async () => {
  const { database, mediaRoot } = await createJobTestContext();
  ensureOrganizationActor(database, "org-2", "user-2");
  const job = seedCanonicalJob(database);
  transitionJob(database, { jobId: job.id, now: 10, command: { type: "attachment-failed" } });
  const service = makeJobService(database, {
    mediaRoot,
    now: () => 20,
    publicBaseUrl: "https://api.densio.test",
  });
  const input = { jobId: job.id, ...fixtureOrganizationActor, correlationId: "test" };
  expect(await Effect.runPromise(service.status(input))).toMatchObject({
    state: "failed",
    receipt: { execution: { attempts: 0, commands: [] } },
    problem: { code: "PREPARED_SOURCE_UNAVAILABLE" },
  });
  database.db.update(jobs).set({ receiptJson: null }).where(eq(jobs.id, job.id)).run();
  expect(await Effect.runPromise(Effect.flip(service.status(input)))).toBeInstanceOf(
    JobRepositoryError,
  );
});
