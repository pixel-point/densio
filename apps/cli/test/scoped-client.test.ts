import { afterEach, expect, it } from "vitest";
import { Schema } from "effect";
import { createAuthenticatedClient } from "../src/authenticated-client.ts";
import { createOrganizationClient, organizationResponse } from "../src/organization-client.ts";
import { makeCliRuntime } from "../src/runtime.ts";
import { writeCredentials } from "../src/config.ts";
import { cleanupCliDirectories, makeCliCapture } from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);
it("pins one identity, refreshes authorization per request, and validates explicit ownership only", async () => {
  const capture = await makeCliCapture();
  const headers: Array<string | null> = [];
  const state = { resourceOrganization: "org-1", identityReads: 0 };
  const runtime = makeCliRuntime(
    { apiUrl: "https://api.test", json: true },
    {
      ...capture.dependencies,
      environment: {},
      fetch: async (url, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        headers.push(authorization);
        const data = String(url).endsWith("/auth/status")
          ? ((state.identityReads += 1),
            {
              authenticated: true,
              user: {
                id: authorization === "Bearer other-user" ? "other" : "user-1",
                email: "one@example.test",
              },
              defaultOrganizationId: "org-1",
              sessionExpiresAt: "2099-01-01T00:00:00.000Z",
            })
          : {
              organizationId: state.resourceOrganization,
              details: { organizationId: "opaque-unrelated-value" },
            };
        return Response.json({ ok: true, schemaVersion: 1, correlationId: "test", data });
      },
    },
  );
  const save = (accessToken: string) =>
    writeCredentials(runtime.credentialsPath, {
      apiUrl: runtime.apiUrl,
      accessToken,
      refreshToken: "refresh",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });
  await save("initial");
  const authenticated = await createAuthenticatedClient(runtime);
  const client = createOrganizationClient(runtime, authenticated, "org-1");
  const response = organizationResponse(
    Schema.Struct({ organizationId: Schema.String, details: Schema.Json }),
    (data) => [data],
  );
  await expect(
    client.request("/v1/organizations/org-1/jobs", {}, response),
  ).resolves.toHaveProperty("data.details.organizationId", "opaque-unrelated-value");
  await save("rotated");
  await client.request("/v1/organizations/org-1/jobs", {}, response);
  await client.request("/v1/organizations/org-1/jobs", {}, response);
  expect(state.identityReads).toBe(2);
  expect(headers.at(-1)).toBe("Bearer rotated");
  state.resourceOrganization = "other";
  await expect(client.request("/v1/organizations/org-1/jobs", {}, response)).rejects.toThrow();
  const count = headers.length;
  await expect(client.request("/v1/organizations/other/jobs", {}, response)).rejects.toThrow();
  expect(headers).toHaveLength(count);
  await save("other-user");
  await expect(client.request("/v1/organizations/org-1/jobs", {}, response)).rejects.toThrow();
});
