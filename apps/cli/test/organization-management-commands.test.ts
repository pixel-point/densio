import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import { readOrganizationContext } from "../src/organization-context-store.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);
const timestamp = "2026-07-11T12:00:00.000Z";
const organization = {
  organizationId: "org-1",
  name: "Team",
  billingEmail: "owner@example.com",
  state: "active",
  createdByUserId: "user-1",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const membership = {
  organizationId: "org-1",
  membershipId: "membership-1",
  userId: "user-1",
  email: "owner@example.com",
  role: "owner",
  isDefault: true,
  joinedAt: timestamp,
};
const invitation = {
  organizationId: "org-1",
  organizationName: "Team",
  invitationId: "invitation-1",
  email: "recipient@example.com",
  role: "member",
  state: "pending",
  invitedByUserId: "user-1",
  createdAt: timestamp,
  expiresAt: "2026-07-18T12:00:00.000Z",
};
const base = "/v1/organizations/org-1";
const cases = [
  {
    argv: ["orgs", "list", "--limit", "3"],
    method: "GET",
    path: "/v1/organizations?limit=3",
    data: { organizations: [{ organization, membership }] },
  },
  {
    argv: ["orgs", "create", "Team", "--idempotency-key", "create-1"],
    method: "POST",
    path: "/v1/organizations",
    body: { name: "Team" },
    key: "create-1",
    data: { organization, membership, replayed: false },
  },
  {
    argv: ["orgs", "rename", "org-1", "New team"],
    method: "PATCH",
    path: base,
    body: { name: "New team" },
    data: { ...organization, name: "New team" },
  },
  {
    argv: ["orgs", "default", "org-1"],
    method: "PUT",
    path: "/v1/auth/default-organization",
    body: { organizationId: "org-1" },
    data: { organizationId: "org-1" },
  },
  {
    argv: ["orgs", "members", "list", "--limit", "2"],
    method: "GET",
    path: `${base}/members?limit=2`,
    data: { organizationId: "org-1", members: [membership] },
  },
  {
    argv: ["orgs", "members", "set-role", "member-1", "--role", "admin"],
    method: "PATCH",
    path: `${base}/members/member-1`,
    body: { role: "admin" },
    data: { ...membership, userId: "member-1", role: "admin" },
  },
  {
    argv: ["orgs", "members", "remove", "member-1"],
    method: "DELETE",
    path: `${base}/members/member-1`,
    data: { organizationId: "org-1", userId: "member-1", removed: true },
  },
  {
    argv: ["orgs", "leave"],
    method: "POST",
    path: `${base}/leave`,
    data: { organizationId: "org-1", userId: "user-1", removed: true },
  },
  {
    argv: ["orgs", "transfer-ownership", "member-1"],
    method: "POST",
    path: `${base}/transfer-ownership`,
    body: { userId: "member-1" },
    data: { ...membership, userId: "member-1" },
  },
  {
    argv: ["orgs", "invitations", "list"],
    method: "GET",
    path: `${base}/invitations`,
    data: { organizationId: "org-1", invitations: [invitation] },
  },
  {
    argv: ["orgs", "invitations", "create", "recipient@example.com", "--role", "member"],
    method: "POST",
    path: `${base}/invitations`,
    body: { email: "recipient@example.com", role: "member" },
    data: invitation,
  },
  {
    argv: ["orgs", "invitations", "revoke", "invitation-1"],
    method: "DELETE",
    path: `${base}/invitations/invitation-1`,
    data: { ...invitation, state: "revoked" },
  },
  {
    argv: ["invitations", "list"],
    method: "GET",
    path: "/v1/organization-invitations",
    data: { invitations: [invitation] },
  },
  {
    argv: ["invitations", "accept", "invitation-1"],
    method: "POST",
    path: "/v1/organization-invitations/invitation-1/accept",
    data: { invitation: { ...invitation, state: "accepted" }, membership, replayed: false },
  },
  {
    argv: ["orgs", "audit-events", "--after", "7", "--limit", "2"],
    method: "GET",
    path: `${base}/audit-events?after=7&limit=2`,
    data: { organizationId: "org-1", events: [], nextAfter: 7 },
  },
  {
    argv: ["orgs", "delete", "org-1", "--confirm", "org-1"],
    method: "DELETE",
    path: base,
    data: {
      organizationId: "org-1",
      state: "deleting",
      requestedAt: timestamp,
      statusUrl: "https://api.example/v1/organizations/org-1",
    },
  },
  {
    argv: ["billing", "contact", "finance@example.com"],
    method: "PATCH",
    path: `${base}/billing/contact`,
    body: { billingEmail: "finance@example.com" },
    data: { organizationId: "org-1", billingEmail: "finance@example.com" },
  },
] as const;

describe("organization management wire commands", () => {
  it.each(cases)("sends $argv to its explicit contract", async (testCase) => {
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      body: string;
      key?: string;
    }> = [];
    const server = await startCliServer(async (request, response) => {
      if (request.url === "/v1/auth/status") {
        sendEnvelope(response, {
          authenticated: true,
          user: { id: "user-1", email: "owner@example.com" },
          defaultOrganizationId: "org-1",
          sessionExpiresAt: "2026-07-12T12:00:00.000Z",
        });
        return;
      }
      if (request.url === base && request.method === "GET") {
        sendEnvelope(response, { organization, membership });
        return;
      }
      requests.push({
        method: request.method,
        path: request.url,
        body: (await readRequestBody(request)).toString(),
        ...(typeof request.headers["idempotency-key"] === "string"
          ? { key: request.headers["idempotency-key"] }
          : {}),
      });
      sendEnvelope(
        response,
        testCase.data,
        request.method === "DELETE" && request.url === base ? 202 : 200,
      );
    });
    const capture = await makeCliCapture();
    await authenticate(capture.dependencies.credentialsPath, server.url);
    const exitCode = await runCli(["--api-url", server.url, "--json", ...testCase.argv], {
      ...capture.dependencies,
      environment: {},
    });
    await server.close();
    expect(exitCode, capture.stderr()).toBe(0);
    expect(requests).toEqual([
      {
        method: testCase.method,
        path: testCase.path,
        body: "body" in testCase ? JSON.stringify(testCase.body) : "",
        ...("key" in testCase ? { key: testCase.key } : {}),
      },
    ]);
    expect(capture.stdout().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(capture.stdout()).data).toEqual(testCase.data);
    expect(
      await readOrganizationContext(capture.dependencies.credentialsPath, server.url, "user-1"),
    ).toBeUndefined();
  });

  it("orgs use persists only local context and positional IDs override environment selection", async () => {
    const requests: Array<string | undefined> = [];
    const server = await startCliServer((request, response) => {
      requests.push(request.url);
      sendEnvelope(
        response,
        request.url === "/v1/auth/status"
          ? {
              authenticated: true,
              user: { id: "user-1", email: "owner@example.com" },
              defaultOrganizationId: "org-1",
              sessionExpiresAt: "2026-07-12T12:00:00.000Z",
            }
          : { organization, membership },
      );
    });
    const capture = await makeCliCapture();
    await authenticate(capture.dependencies.credentialsPath, server.url);
    const exitCode = await runCli(["--api-url", server.url, "--json", "orgs", "use", "org-1"], {
      ...capture.dependencies,
      environment: { DENSIO_ORG_ID: "ignored" },
    });
    await server.close();
    expect(exitCode).toBe(0);
    expect(requests).toEqual(["/v1/auth/status", base]);
    expect(
      await readOrganizationContext(capture.dependencies.credentialsPath, server.url, "user-1"),
    ).toBe("org-1");
  });
});

const authenticate = (credentialsPath: string, apiUrl: string) =>
  writeCredentials(credentialsPath, {
    apiUrl,
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
  });

it("refuses to save a closing organization as local context", async () => {
  const server = await startCliServer((request, response) =>
    sendEnvelope(
      response,
      request.url === "/v1/auth/status"
        ? {
            authenticated: true,
            user: { id: "user-1", email: "owner@example.com" },
            defaultOrganizationId: "org-1",
            sessionExpiresAt: "2026-07-12T12:00:00.000Z",
          }
        : {
            organization: { ...organization, state: "deleting", deletionRequestedAt: timestamp },
            membership,
          },
    ),
  );
  const capture = await makeCliCapture();
  await authenticate(capture.dependencies.credentialsPath, server.url);
  const exitCode = await runCli(
    ["--api-url", server.url, "--json", "orgs", "use", "org-1"],
    capture.dependencies,
  );
  await server.close();
  expect(exitCode).not.toBe(0);
  expect(
    await readOrganizationContext(capture.dependencies.credentialsPath, server.url, "user-1"),
  ).toBeUndefined();
});
