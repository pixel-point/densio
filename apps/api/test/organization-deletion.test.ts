import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { mkdtemp, rm, mkdir, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { makeOrganizationDeletionService } from "../src/organizations/organization-deletion-service.ts";
import {
  organizations,
  preparedSources,
  stripeCustomers,
  stripeSubscriptions,
} from "../src/database/schema.ts";
import { findDefaultOrganizationId } from "../src/database/organization-membership-repository.ts";
import { unusedStripeGateway } from "./unused-stripe-gateway.ts";
import type { StripeSubscriptionState } from "../src/billing/stripe-gateway.ts";
import { openDatabase } from "../src/database/database.ts";

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
  const mediaRoot = await mkdtemp(join(tmpdir(), "densio-org-delete-"));
  const databasePath = join(mediaRoot, "database.sqlite");
  const fixture = organizationFixture(databasePath);
  fixtures.push({ database: fixture.database, mediaRoot });
  const subscriptions: StripeSubscriptionState[] = [];
  const service = makeOrganizationDeletionService(
    fixture.database,
    {
      ...unusedStripeGateway,
      listCustomerSubscriptions: () => Effect.succeed(subscriptions),
      retrieveSubscription: (id) => {
        const found = subscriptions.find((subscription) => subscription.subscriptionId === id);
        return found === undefined ? Effect.die("Unexpected subscription") : Effect.succeed(found);
      },
    },
    {
      mediaRoot,
      publicBaseUrl: "https://api.densio.test",
      now: () => organizationNow,
    },
  );
  const input = {
    actor: {
      organizationId: fixture.organizationId,
      userId: "owner",
      membershipId: fixture.team.membership.id,
    },
    correlationId: "delete-test",
  };
  return { ...fixture, service, input, subscriptions, mediaRoot, databasePath };
};

it("accepts closure atomically, replaces member defaults, and finishes through maintenance", async () => {
  const fixture = await setup();
  const receipt = await Effect.runPromise(fixture.service.request(fixture.input));
  expect(receipt).toMatchObject({
    organizationId: fixture.organizationId,
    state: "deleting",
    statusUrl: `https://api.densio.test/v1/organizations/${fixture.organizationId}`,
  });
  for (const userId of ["owner", "admin", "member"])
    expect(findDefaultOrganizationId(fixture.database.db, userId)).not.toBe(fixture.organizationId);
  expect(await Effect.runPromise(fixture.service.request(fixture.input))).toEqual(receipt);
  await Effect.runPromise(fixture.service.maintain({ now: organizationNow + 1 }));
  expect(await Effect.runPromise(fixture.service.request(fixture.input))).toMatchObject({
    state: "deleted",
  });
});

it("reports upload and subscription blockers without changing defaults or state", async () => {
  const fixture = await setup();
  fixture.database.db
    .insert(preparedSources)
    .values({
      id: "pending-source",
      organizationId: fixture.organizationId,
      createdByUserId: "owner",
      state: "awaiting-upload",
      sourceFilename: "clip.mp4",
      declaredBytes: 5,
      maxUploadBytes: 100,
      requestDigest: "a".repeat(64),
      createdAt: organizationNow,
      updatedAt: organizationNow,
      expiresAt: organizationNow + 100_000,
      uploadExpiresAt: organizationNow + 10_000,
    })
    .run();
  const failure = await Effect.runPromise(Effect.flip(fixture.service.request(fixture.input)));
  expect(failure).toMatchObject({
    code: "ORGANIZATION_DELETION_BLOCKED",
    details: { blockers: [{ kind: "uploads", count: 1 }] },
  });
  expect(findDefaultOrganizationId(fixture.database.db, "owner")).toBe(fixture.organizationId);
  expect(
    fixture.database.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, fixture.organizationId))
      .get()?.state,
  ).toBe("active");
  fixture.database.db.update(preparedSources).set({ state: "deleted" }).run();
  fixture.database.db
    .insert(stripeCustomers)
    .values({
      organizationId: fixture.organizationId,
      customerId: "cus_1",
      createdAt: organizationNow,
    })
    .run();
  fixture.database.db
    .insert(stripeSubscriptions)
    .values({
      organizationId: fixture.organizationId,
      customerId: "cus_1",
      subscriptionId: "sub_1",
      priceId: "price_basic",
      status: "active",
      cancelAtPeriodEnd: true,
      updatedAt: organizationNow,
    })
    .run();
  expect(
    await Effect.runPromise(Effect.flip(fixture.service.request(fixture.input))),
  ).toMatchObject({
    code: "ORGANIZATION_DELETION_BLOCKED",
    details: { blockers: [{ kind: "subscriptions", count: 1 }] },
  });
  fixture.subscriptions.push({
    organizationId: fixture.organizationId,
    customerId: "cus_1",
    subscriptionId: "sub_1",
    status: "canceled",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: organizationNow,
    priceId: "price_basic",
  });
  expect(await Effect.runPromise(fixture.service.request(fixture.input))).toMatchObject({
    state: "deleting",
  });
});

it("retries failed byte cleanup after restart and drains more than one page", async () => {
  const fixture = await setup();
  const sources = Array.from(
    { length: 51 },
    (_, index) => `source-${String(index).padStart(3, "0")}`,
  );
  fixture.database.db
    .insert(preparedSources)
    .values(
      sources.map((id) => ({
        id,
        organizationId: fixture.organizationId,
        createdByUserId: "owner",
        state: "failed" as const,
        sourceFilename: "clip.mp4",
        declaredBytes: 5,
        maxUploadBytes: 100,
        requestDigest: "a".repeat(64),
        createdAt: organizationNow,
        updatedAt: organizationNow,
        expiresAt: organizationNow + 100_000,
        uploadExpiresAt: organizationNow + 10_000,
      })),
    )
    .run();
  const sourceRoot = join(fixture.mediaRoot, "sources");
  await writeFile(sourceRoot, "filesystem obstruction");
  await Effect.runPromise(fixture.service.request(fixture.input));
  await Effect.runPromise(fixture.service.maintain({ now: organizationNow + 1 }));
  expect(
    fixture.database.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, fixture.organizationId))
      .get(),
  ).toMatchObject({ state: "deleting", cleanupError: "pending-resource-cleanup" });
  await rename(sourceRoot, join(fixture.mediaRoot, "obstruction"));
  await Promise.all(
    sources.map(async (id) => {
      await mkdir(join(sourceRoot, id), { recursive: true });
      await writeFile(join(sourceRoot, id, "bytes"), "video");
    }),
  );
  fixture.database.close();
  Object.assign(fixture.database, openDatabase(fixture.databasePath));
  const restarted = makeOrganizationDeletionService(fixture.database, unusedStripeGateway, {
    mediaRoot: fixture.mediaRoot,
    publicBaseUrl: "https://api.densio.test",
    now: () => organizationNow + 2,
  });
  await Effect.runPromise(restarted.maintain({ now: organizationNow + 2 }));
  expect(await readdir(sourceRoot)).toEqual([]);
  expect(await Effect.runPromise(restarted.request(fixture.input))).toMatchObject({
    state: "deleted",
  });
  expect(
    fixture.database.db
      .select()
      .from(preparedSources)
      .all()
      .every(({ cleanedAt }) => cleanedAt !== null),
  ).toBe(true);
});
