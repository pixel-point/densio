import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { listOwnedJobs } from "../src/database/job-query-repository.ts";
import { createJobTestContext, cleanupJobFixtures, seedCanonicalJob } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("puts only keyset coordinates in a job cursor and isolates owner histories", async () => {
  const { database } = await createJobTestContext();
  seedCanonicalJob(database, { id: "a", createdAt: 10 });
  seedCanonicalJob(database, { id: "b", createdAt: 10 });
  seedCanonicalJob(database, {
    id: "foreign",
    organizationId: "org-2",
    createdByUserId: "user-2",
    createdAt: 11,
  });
  const page = await Effect.runPromise(
    listOwnedJobs(database, { organizationId: "org-1", limit: 1 }),
  );
  expect(page.jobs.map(({ id }) => id)).toEqual(["b"]);
  expect(JSON.parse(Buffer.from(page.nextCursor ?? "", "base64url").toString())).toEqual({
    createdAt: 10,
    id: "b",
  });
  const next = await Effect.runPromise(
    listOwnedJobs(database, { organizationId: "org-1", limit: 1, cursor: page.nextCursor ?? "" }),
  );
  expect(next.jobs.map(({ id }) => id)).toEqual(["a"]);
  expect(next).not.toHaveProperty("nextCursor");
});
