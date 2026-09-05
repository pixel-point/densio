import { afterEach, expect, test } from "vitest";
import { Hono } from "hono";
import { Schema } from "effect";
import {
  StorageConnectionCreateResponseSchema,
  StorageUsageResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { hashTokenSecret } from "../src/auth/opaque-token.ts";
import { sessions } from "../src/database/schema.ts";
import { makeOrganizationService } from "../src/organizations/organization-service.ts";
import { makeVideoService } from "../src/videos/video-service.ts";
import { makeStorageConnectionService } from "../src/storage/connections/connection-service.ts";
import { createStorageRoutes } from "../src/routes/video-storage.ts";
import { registerDocumentationRoutes } from "../src/routes/documentation.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  fixture.database.db
    .insert(sessions)
    .values(
      ["owner", "member", "outsider"].map((userId) => ({
        id: `storage-session-${userId}`,
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
  const config = {
    now: () => organizationNow,
    priceIds: { basic: "basic", pro: "pro", scale: "scale" },
    mediaRoot: "/unused",
    publicBaseUrl: "https://api.example.test",
  };
  const app = new Hono().route(
    "/",
    createStorageRoutes({
      authService: makeAuthService(fixture.database, makeMagicLinkSealer("ab".repeat(32))),
      organizationService: makeOrganizationService(fixture.database),
      now: config.now,
      createCorrelationId: () => "storage-route",
      videoService: makeVideoService(fixture.database, config),
      connectionService: makeStorageConnectionService(fixture.database, {
        now: config.now,
        activeCredentialKey: "primary",
        credentialKeys: { primary: "cd".repeat(32) },
      }),
    }),
  );
  registerDocumentationRoutes(app);
  return {
    ...fixture,
    app,
    base: `/v1/organizations/${fixture.organizationId}`,
    headers: (user = "owner") => ({
      authorization: `Bearer storage-session-${user}.${secret(user)}`,
      "content-type": "application/json",
      "idempotency-key": "test-request",
    }),
  };
};

test("storage routes enforce authentication and organization scope and expose documented usage", async () => {
  const { app, base, headers } = setup();
  expect((await app.request(`${base}/storage/usage`)).status).toBe(401);
  expect(
    (await app.request(`${base}/storage/usage`, { headers: headers("outsider") })).status,
  ).toBe(404);
  const response = await app.request(`${base}/storage/usage`, { headers: headers("member") });
  expect(response.status).toBe(200);
  expect(
    Schema.decodeUnknownSync(successEnvelope(StorageUsageResponseSchema))(await response.json())
      .data.usage,
  ).toMatchObject({ plan: "free", includedStorageBytes: 0 });
  const openapi = Schema.decodeUnknownSync(
    Schema.Struct({
      paths: Schema.Record(
        Schema.String,
        Schema.Struct({
          get: Schema.optionalKey(
            Schema.Struct({ responses: Schema.Record(Schema.String, Schema.Unknown) }),
          ),
        }),
      ),
    }),
  )(await (await app.request("/openapi.json")).json());
  expect(
    openapi.paths["/v1/organizations/{organizationId}/storage/usage"]?.get?.responses,
  ).toHaveProperty("401");
});

test("connection creation has a sanitized shared response and a role-protected HTTP contract", async () => {
  const { app, base, headers } = setup();
  const body = JSON.stringify({
    name: "Website",
    config: {
      provider: "s3",
      visibility: "public",
      publicBaseUrl: "https://media.example.test",
      location: {
        endpoint: "https://s3.eu-west-1.amazonaws.com",
        region: "eu-west-1",
        bucket: "website-media",
        prefix: "uploads",
        pathStyle: true,
      },
    },
    credentials: { accessKeyId: "fixture", secretAccessKey: "never-return-this" },
  });
  expect(
    (
      await app.request(`${base}/storage/connections`, {
        method: "POST",
        headers: headers("member"),
        body,
      })
    ).status,
  ).toBe(403);
  const response = await app.request(`${base}/storage/connections`, {
    method: "POST",
    headers: headers(),
    body,
  });
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain("never-return-this");
  expect(
    Schema.decodeUnknownSync(
      Schema.fromJsonString(successEnvelope(StorageConnectionCreateResponseSchema)),
    )(text).data.connection.state,
  ).toBe("pending-validation");
});

test("video list rejects invalid filters, limits and malformed cursors", async () => {
  const { app, base, headers } = setup();
  for (const query of ["limit=0", "limit=101", "limit=bad", "state=bogus", "cursor=bad"]) {
    const response = await app.request(`${base}/videos?${query}`, { headers: headers() });
    expect(response.status, query).toBe(400);
  }
});

const secret = (user: string) => user.padEnd(44, "a");
