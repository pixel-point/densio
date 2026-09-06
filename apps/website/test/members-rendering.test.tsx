import { once } from "node:events";
import { createServer } from "node:http";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { MembersSettings } from "@/components/pages/account/members";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "test-session" }) }),
}));
const createdAt = "2026-09-01T00:00:00.000Z";
const member = {
  membershipId: "membership",
  organizationId: "org",
  userId: "owner",
  email: "owner@densio.test",
  role: "owner",
  joinedAt: createdAt,
  isDefault: true,
};
const responses: Record<string, unknown> = {
  "/v1/auth/status": {
    authenticated: true,
    user: { id: "owner", email: member.email },
    defaultOrganizationId: "org",
    sessionExpiresAt: "2030-01-01T00:00:00.000Z",
  },
  "/v1/organizations/org": {
    organization: {
      organizationId: "org",
      name: "Test organization",
      billingEmail: member.email,
      state: "active",
      createdByUserId: "owner",
      createdAt,
      updatedAt: createdAt,
    },
    membership: member,
  },
  "/v1/organizations/org/members?limit=25": { organizationId: "org", members: [member] },
  "/v1/organizations/org/invitations?state=pending&limit=25": {
    organizationId: "org",
    invitations: [
      {
        invitationId: "invitation",
        organizationId: "org",
        organizationName: "Test organization",
        email: "invited@densio.test",
        role: "member",
        state: "pending",
        invitedByUserId: "owner",
        createdAt,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    ],
  },
};
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it("renders members and invitations together without a second asynchronous content boundary", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        schemaVersion: 1,
        correlationId: "test",
        data: responses[request.url ?? ""],
      }),
    );
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  vi.stubEnv("DENSIO_API_URL", `http://127.0.0.1:${address.port}`);
  const page = await MembersSettings({ organizationId: "org", query: {} });
  const html = renderToStaticMarkup(page);
  expect(html).toContain("owner@densio.test");
  expect(html).toContain("invited@densio.test");
  expect(html).toContain("Send invitation");
});
