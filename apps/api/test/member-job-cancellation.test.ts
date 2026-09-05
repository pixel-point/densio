import { afterEach, expect, it } from "vitest";
import { cancelOrganizationJob, transitionJob } from "../src/database/job-transition-repository.ts";
import { jobs, jobCreditEntries } from "../src/database/schema.ts";
import { queueCanonicalJob } from "./job-fixture.ts";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));

it("derives cancellation scope from the authorized membership, never from a separate target organization", () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  const job = queueCanonicalJob(fixture.database, {
    id: "foreign-job",
    organizationId: fixture.outside.organization.id,
    createdByUserId: "outsider",
    createdAt: organizationNow,
  });
  const credits = fixture.database.db.select().from(jobCreditEntries).all();
  const actor = {
    organizationId: fixture.organizationId,
    userId: "owner",
    membershipId: fixture.team.membership.id,
  };
  expect(
    cancelOrganizationJob(fixture.database, { actor, jobId: job.id, now: organizationNow + 2 }),
  ).toBeUndefined();
  expect(fixture.database.db.select().from(jobs).get()?.state).toBe("queued");
  expect(fixture.database.db.select().from(jobCreditEntries).all()).toEqual(credits);
  expect(
    transitionJob(fixture.database, {
      jobId: job.id,
      now: organizationNow + 3,
      command: { type: "claim", workerId: "worker", leaseDurationMs: 1000 },
    })?.state,
  ).toBe("analyzing");
  expect(
    cancelOrganizationJob(fixture.database, {
      actor: {
        organizationId: job.organizationId,
        userId: "outsider",
        membershipId: fixture.outside.membership.id,
      },
      jobId: job.id,
      now: organizationNow + 4,
    })?.cancelRequestedAt,
  ).toBe(organizationNow + 4);
});
