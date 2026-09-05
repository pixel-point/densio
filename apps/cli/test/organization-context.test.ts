import { stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeCredentials } from "../src/config.ts";
import { organizationResponses } from "../src/organization-responses.ts";
import { jobBase } from "./canonical-fixtures.ts";
import { organizationPath, selectOrganization } from "../src/organization-context.ts";
import {
  organizationContextPath,
  writeOrganizationContext,
} from "../src/organization-context-store.ts";
import { makeCliRuntime } from "../src/runtime.ts";
import { cleanupCliDirectories, makeCliCapture } from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("pinned organization context", () => {
  it("uses flag, environment, identity-bound local selection, then server default", async () => {
    const fixture = await contextFixture();
    await writeOrganizationContext(fixture.runtime.credentialsPath, {
      apiOrigin: fixture.runtime.apiUrl,
      userId: "user-1",
      organizationId: "saved",
    });
    expect(
      (
        await selectOrganization({
          ...fixture.runtime,
          explicitOrganizationId: "flag",
          environmentOrganizationId: "environment",
        })
      ).organization?.organizationId,
    ).toBe("flag");
    expect(
      (await selectOrganization({ ...fixture.runtime, environmentOrganizationId: "environment" }))
        .organization?.organizationId,
    ).toBe("environment");
    expect((await selectOrganization(fixture.runtime)).organization?.organizationId).toBe("saved");
    await writeOrganizationContext(fixture.runtime.credentialsPath, {
      apiOrigin: fixture.runtime.apiUrl,
      userId: "someone-else",
      organizationId: "foreign",
    });
    expect((await selectOrganization(fixture.runtime)).organization?.organizationId).toBe(
      "default",
    );
    expect(
      (await stat(organizationContextPath(fixture.runtime.credentialsPath))).mode & 0o777,
    ).toBe(0o600);
  });

  it("ignores selections from another API origin and rejects invalid selected organizations without fallback", async () => {
    const fixture = await contextFixture();
    await writeOrganizationContext(fixture.runtime.credentialsPath, {
      apiOrigin: "https://other.example",
      userId: "user-1",
      organizationId: "foreign",
    });
    expect((await selectOrganization(fixture.runtime)).organization?.organizationId).toBe(
      "default",
    );
    await expect(
      selectOrganization({ ...fixture.runtime, explicitOrganizationId: "missing" }),
    ).rejects.toThrow();
    expect(fixture.paths.at(-1)).toBe("/v1/organizations/missing");
  });

  it("rejects cross-origin and cross-organization control URLs before making a request", async () => {
    const fixture = await contextFixture();
    const runtime = await selectOrganization(fixture.runtime);
    const count = fixture.paths.length;
    for (const path of [
      "https://untrusted.example/steal",
      "/v1/organizations/other/jobs/job-1",
      "/v1/jobs/job-1",
    ]) {
      await expect(
        runtime.organizationClient.request(
          path,
          { headers: { authorization: "Bearer access" } },
          organizationResponses.JobStatus,
        ),
      ).rejects.toThrow();
    }
    expect(fixture.paths).toHaveLength(count);
    expect(organizationPath(runtime, "/jobs/job-1")).toBe("/v1/organizations/default/jobs/job-1");
  });

  it("does not switch accounts or organizations when credentials change during a command", async () => {
    const fixture = await contextFixture();
    const runtime = await selectOrganization(fixture.runtime);
    await fixture.save("other-access");
    await expect(
      runtime.organizationClient.request(
        organizationPath(runtime),
        {},
        organizationResponses.OrganizationMembership,
      ),
    ).rejects.toThrow();
    expect(runtime.organization?.organizationId).toBe("default");
  });

  it("rejects a scoped response containing another organization's resource", async () => {
    const fixture = await contextFixture();
    const runtime = await selectOrganization(fixture.runtime);
    await expect(
      runtime.organizationClient.request(
        organizationPath(runtime, "/jobs"),
        {},
        organizationResponses.JobListResponse,
      ),
    ).rejects.toThrow();
  });
});

const contextFixture = async () => {
  const capture = await makeCliCapture();
  const paths: Array<string> = [];
  const runtime = makeCliRuntime(
    { json: true, apiUrl: "https://api.example" },
    {
      ...capture.dependencies,
      environment: {},
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        const userId =
          new Headers(init?.headers).get("authorization") === "Bearer other-access"
            ? "other-user"
            : "user-1";
        if (path === "/v1/auth/status")
          return envelope({
            authenticated: true,
            user: { id: userId, email: "owner@example.com" },
            defaultOrganizationId: "default",
            sessionExpiresAt: "2026-07-12T12:00:00.000Z",
          });
        if (path.endsWith("/jobs"))
          return envelope({
            organizationId: "default",
            jobs: [
              {
                ...jobBase,
                organizationId: "other",
                state: "queued",
                progress: { phase: "queued", percent: 0, attempt: 0, revision: 0 },
              },
            ],
          });
        const organizationId = path.split("/").at(-1);
        if (organizationId === "missing") return new Response("{}", { status: 404 });
        const timestamp = "2026-07-11T12:00:00.000Z";
        return envelope({
          organization: {
            organizationId,
            name: "Team",
            state: "active",
            billingEmail: "owner@example.com",
            createdByUserId: userId,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          membership: {
            membershipId: "membership-1",
            organizationId,
            userId,
            email: "owner@example.com",
            role: "owner",
            joinedAt: timestamp,
            isDefault: true,
          },
        });
      },
    },
  );
  const save = (accessToken: string) =>
    writeCredentials(runtime.credentialsPath, {
      accessToken,
      refreshToken: "refresh",
      accessTokenExpiresAt: "2026-07-12T12:00:00.000Z",
      apiUrl: runtime.apiUrl,
    });
  await save("access");
  return { runtime, paths, save };
};

const envelope = (data: unknown) =>
  Response.json({ data, ok: true, schemaVersion: 1, correlationId: "test" });
