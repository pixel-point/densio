import { Effect, Schema } from "effect";
import { Hono } from "hono";
import {
  AuthStatusSchema,
  OrganizationCreateResponseSchema,
  OrganizationMembersResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { afterEach, expect, it } from "vitest";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { hashTokenSecret } from "../src/auth/opaque-token.ts";
import { sessions } from "../src/database/schema.ts";
import { makeOrganizationService } from "../src/organizations/organization-service.ts";
import { createOrganizationRoutes } from "../src/routes/organizations.ts";
import { makeOrganizationInvitationService } from "../src/organizations/organization-invitation-service.ts";
import { createOrganizationInvitationRoutes } from "../src/routes/organization-invitations.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
const secret = (userId: string) => `${userId}${"a".repeat(43)}`;
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const harness = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  const authService = makeAuthService(
    fixture.database,
    makeMagicLinkSealer("0123456789abcdef".repeat(4)),
  );
  fixture.database.db
    .insert(sessions)
    .values(
      ["owner", "admin", "member", "outsider"].map((userId) => ({
        id: `test-session-id-${userId}`,
        userId,
        accessTokenHash: hashTokenSecret(secret(userId)),
        accessExpiresAt: organizationNow + 60_000,
        refreshExpiresAt: organizationNow + 600_000,
        createdAt: organizationNow,
        updatedAt: organizationNow,
        familyId: `family-${userId}`,
      })),
    )
    .run();
  const headers = (userId: string) => ({
    authorization: `Bearer test-session-id-${userId}.${secret(userId)}`,
    "content-type": "application/json",
  });
  return { ...fixture, authService, headers };
};

it("registers authenticated org management with strict body and role checks", async () => {
  expect(createOrganizationRoutes).toBeDefined();
  const fixture = harness();
  const app = new Hono().route(
    "/",
    createOrganizationRoutes({
      authService: fixture.authService,
      organizationService: makeOrganizationService(fixture.database),
      now: () => organizationNow,
      createCorrelationId: () => "org-route",
      maxCreatesPerDay: 10,
      publicBaseUrl: "https://api.densio.test",
    }),
  );
  expect((await app.request("/v1/organizations")).status).toBe(401);
  const created = await app.request("/v1/organizations", {
    method: "POST",
    headers: { ...fixture.headers("owner"), "idempotency-key": "new" },
    body: JSON.stringify({ name: "Product" }),
  });
  expect(created.status).toBe(201);
  expect(
    Schema.decodeUnknownSync(successEnvelope(OrganizationCreateResponseSchema))(
      await created.json(),
    ).data.organization.name,
  ).toBe("Product");
  const base = `/v1/organizations/${fixture.organizationId}`;
  expect((await app.request(base, { headers: fixture.headers("outsider") })).status).toBe(404);
  expect(
    (
      await app.request(base, {
        method: "PATCH",
        headers: fixture.headers("member"),
        body: JSON.stringify({ name: "No" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(base, {
        method: "PATCH",
        headers: fixture.headers("owner"),
        body: JSON.stringify({ name: "No", userId: "outsider" }),
      })
    ).status,
  ).toBe(400);
  const members = await app.request(`${base}/members`, { headers: fixture.headers("member") });
  expect(members.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(successEnvelope(OrganizationMembersResponseSchema))(
      await members.json(),
    ).data.members,
  ).toHaveLength(3);
  expect(
    (await app.request(`${base}/audit-events`, { headers: fixture.headers("member") })).status,
  ).toBe(403);
  const identity = await Effect.runPromise(
    fixture.authService.lookupAccess({
      accessToken: fixture.headers("owner").authorization.slice(7),
      now: organizationNow,
    }),
  );
  expect(
    Schema.is(AuthStatusSchema)({
      authenticated: true,
      user: { id: identity.userId, email: identity.email },
      defaultOrganizationId: identity.defaultOrganizationId,
      sessionExpiresAt: new Date(identity.accessExpiresAt).toISOString(),
    }),
  ).toBe(true);
});

it("lets only the addressed recipient discover and accept invitations", async () => {
  expect(createOrganizationInvitationRoutes).toBeDefined();
  const fixture = harness();
  const app = new Hono().route(
    "/",
    createOrganizationInvitationRoutes({
      authService: fixture.authService,
      organizationService: makeOrganizationService(fixture.database),
      invitationService: makeOrganizationInvitationService(fixture.database),
      now: () => organizationNow,
      createCorrelationId: () => "invitation-route",
      maxCreatesPerDay: 10,
      maxInvitationsPerHour: 30,
      publicBaseUrl: "https://api.densio.test",
    }),
  );
  const path = `/v1/organizations/${fixture.organizationId}/invitations`;
  const created = await app.request(path, {
    method: "POST",
    headers: fixture.headers("owner"),
    body: JSON.stringify({ email: "outsider@example.test", role: "member" }),
  });
  expect(created.status).toBe(200);
  const result = (await created.json()) as { data: { invitationId: string } };
  const received = await app.request("/v1/organization-invitations", {
    headers: fixture.headers("outsider"),
  });
  expect(received.status).toBe(200);
  expect(await received.json()).toMatchObject({
    data: { invitations: [{ invitationId: result.data.invitationId }] },
  });
  const acceptPath = `/v1/organization-invitations/${result.data.invitationId}/accept`;
  expect(
    (await app.request(acceptPath, { method: "POST", headers: fixture.headers("member") })).status,
  ).toBe(404);
  expect(
    (await app.request(acceptPath, { method: "POST", headers: fixture.headers("outsider") }))
      .status,
  ).toBe(200);
  expect((await app.request(path, { headers: fixture.headers("outsider") })).status).toBe(403);
});
