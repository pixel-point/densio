import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { createJobTestContext, cleanupJobFixtures, succeedCanonicalJob } from "./job-fixture.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";
import {
  authorizeOwnedArtifact,
  findGrantedArtifact,
} from "../src/database/artifact-repository.ts";
import { organizationMemberships, organizations } from "../src/database/schema.ts";

afterEach(cleanupJobFixtures);
it("ties each download grant to its issuing membership, not the human identity", async () => {
  const { database } = await createJobTestContext();
  const owner = ensureOrganizationActor(database, "org-1", "owner");
  const member = ensureOrganizationActor(database, "org-1", "member");
  succeedCanonicalJob(
    database,
    [
      {
        id: "artifact-1",
        organizationId: "org-1",
        jobId: "job-1",
        kind: "video",
        filename: "video.webm",
        mediaType: "video/webm",
        path: "/test-only/video.webm",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        retainedUntil: 10_000,
        createdAt: 10,
      },
    ],
    { createdByUserId: "owner" },
  );
  const first = await Effect.runPromise(
    authorizeOwnedArtifact(database, {
      ...owner,
      artifactId: "artifact-1",
      now: 100,
      accessTtlMs: 1000,
    }),
  );
  const second = await Effect.runPromise(
    authorizeOwnedArtifact(database, {
      ...member,
      artifactId: "artifact-1",
      now: 100,
      accessTtlMs: 1000,
    }),
  );
  expect(first.kind).toBe("authorized");
  expect(second.kind).toBe("authorized");
  if (first.kind !== "authorized" || second.kind !== "authorized")
    throw new Error("Test grants missing");
  database.db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.id, member.membershipId))
    .run();
  expect(
    await Effect.runPromise(
      Effect.flip(
        findGrantedArtifact(database, { artifactId: "artifact-1", token: second.token, now: 101 }),
      ),
    ),
  ).toMatchObject({ reason: "invalid" });
  await Effect.runPromise(
    findGrantedArtifact(database, { artifactId: "artifact-1", token: first.token, now: 101 }),
  );
  database.db
    .update(organizations)
    .set({ state: "deleting" })
    .where(eq(organizations.id, "org-1"))
    .run();
  expect(
    await Effect.runPromise(
      Effect.flip(
        findGrantedArtifact(database, { artifactId: "artifact-1", token: first.token, now: 101 }),
      ),
    ),
  ).toMatchObject({ reason: "invalid" });
});
