import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { listOwnedPreparedSources } from "../src/database/source-query-repository.ts";
import { fixtureOrganizationActor } from "./organization-fixture-identity.ts";
import { preparedSources } from "../src/database/schema.ts";
import { seedJobInput, createJobTestContext, cleanupJobFixtures } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("paginates owner source history with inclusive since and exact keyset coordinates", async () => {
  const { database } = await createJobTestContext();
  for (const id of ["a", "b", "c"]) seedJobInput(database, { id, sourceId: id, createdAt: 20 });
  seedJobInput(database, { id: "old", sourceId: "old", createdAt: 10 });
  seedJobInput(database, {
    id: "foreign",
    sourceId: "foreign",
    organizationId: "org-2",
    createdByUserId: "user-2",
    createdAt: 30,
  });
  const query = {
    ...fixtureOrganizationActor,
    now: 40,
    since: new Date(20).toISOString(),
    limit: 2,
  };
  const page = await Effect.runPromise(listOwnedPreparedSources(database, query));
  expect(page.sources.map(({ id }) => id)).toEqual(["c", "b"]);
  expect(JSON.parse(Buffer.from(page.nextCursor ?? "", "base64url").toString())).toEqual({
    createdAt: 20,
    id: "b",
  });
  const next = await Effect.runPromise(
    listOwnedPreparedSources(database, { ...query, cursor: page.nextCursor ?? "" }),
  );
  expect(next.sources.map(({ id }) => id)).toEqual(["a"]);
  expect(next).not.toHaveProperty("nextCursor");
});

it("applies due expiry before filtering and retains deleted history", async () => {
  const { database } = await createJobTestContext();
  for (const id of ["ready", "pending", "deleted"]) seedJobInput(database, { id, sourceId: id });
  database.db
    .update(preparedSources)
    .set({ expiresAt: 20 })
    .where(eq(preparedSources.id, "ready"))
    .run();
  database.db
    .update(preparedSources)
    .set({ state: "awaiting-upload", uploadExpiresAt: 20 })
    .where(eq(preparedSources.id, "pending"))
    .run();
  database.db
    .update(preparedSources)
    .set({ state: "deleted", deletedAt: 10 })
    .where(eq(preparedSources.id, "deleted"))
    .run();
  expect(
    (
      await Effect.runPromise(
        listOwnedPreparedSources(database, {
          ...fixtureOrganizationActor,
          now: 20,
          state: "expired",
          limit: 10,
        }),
      )
    ).sources.map(({ id }) => id),
  ).toEqual(["ready", "pending"]);
  expect(
    (
      await Effect.runPromise(
        listOwnedPreparedSources(database, {
          ...fixtureOrganizationActor,
          now: 20,
          state: "deleted",
          limit: 10,
        }),
      )
    ).sources.map(({ id }) => id),
  ).toEqual(["deleted"]);
});

it("rejects malformed cursors without exposing unrelated storage failures", async () => {
  const { database } = await createJobTestContext();
  expect(
    await Effect.runPromise(
      Effect.flip(
        listOwnedPreparedSources(database, {
          ...fixtureOrganizationActor,
          now: 20,
          cursor: "not-json",
          limit: 10,
        }),
      ),
    ),
  ).toMatchObject({ _tag: "InvalidSourceListCursor" });
});
