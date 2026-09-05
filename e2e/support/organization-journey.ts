import { expect } from "vitest";
import { runCli, startCli } from "./driver.ts";
import {
  decodeArtifactAuthorization,
  decodeAuthStatus,
  decodeBillingStatus,
  decodeInvitation,
  decodeInvitationAcceptance,
  decodeJobAccepted,
  decodeJobStatus,
  decodeOrganization,
} from "./contracts.ts";

export const joinOrganization = async (
  apiUrl: string,
  ownerCredentials: string,
  memberCredentials: string,
  organizationId: string,
) => {
  const before = decodeAuthStatus(
    JSON.parse((await runCli(apiUrl, memberCredentials, ["auth", "status"])).stdout),
  ).data;
  if (!before.authenticated) throw new Error("Member is not authenticated.");
  const invitation = decodeInvitation(
    JSON.parse(
      (
        await runCli(apiUrl, ownerCredentials, [
          "--org",
          organizationId,
          "orgs",
          "invitations",
          "create",
          "member@densio.test",
          "--role",
          "member",
        ])
      ).stdout,
    ),
  ).data;
  const accepted = decodeInvitationAcceptance(
    JSON.parse(
      (await runCli(apiUrl, memberCredentials, ["invitations", "accept", invitation.invitationId]))
        .stdout,
    ),
  ).data;
  expect(accepted.membership.organizationId).toBe(organizationId);
  const after = decodeAuthStatus(
    JSON.parse((await runCli(apiUrl, memberCredentials, ["auth", "status"])).stdout),
  ).data;
  expect(after).toMatchObject({ defaultOrganizationId: before.defaultOrganizationId });
  await runCli(apiUrl, memberCredentials, ["orgs", "use", organizationId]);
  return {
    memberCredentials,
    memberId: before.user.id,
    organizationId,
    memberDefault: before.defaultOrganizationId,
  };
};

type Team = Awaited<ReturnType<typeof joinOrganization>> & { outsiderCredentials: string };

export const createTeamOrganization = async (apiUrl: string, credentials: string) => {
  const before = decodeAuthStatus(
    JSON.parse((await runCli(apiUrl, credentials, ["auth", "status"])).stdout),
  ).data;
  if (!before.authenticated) throw new Error("Expected authenticated owner.");
  const created = decodeOrganization(
    JSON.parse(
      (
        await runCli(apiUrl, credentials, [
          "orgs",
          "create",
          "E2E team",
          "--idempotency-key",
          "e2e-team",
        ])
      ).stdout,
    ),
  ).data;
  const after = decodeAuthStatus(
    JSON.parse((await runCli(apiUrl, credentials, ["auth", "status"])).stdout),
  ).data;
  expect(after).toMatchObject({ defaultOrganizationId: before.defaultOrganizationId });
  await runCli(apiUrl, credentials, ["orgs", "use", created.organization.organizationId]);
  return {
    organizationId: created.organization.organizationId,
    defaultOrganizationId: before.defaultOrganizationId,
  };
};

export const verifyDefaultClosure = async (
  apiUrl: string,
  credentials: string,
  team: { organizationId: string; defaultOrganizationId: string },
) => {
  const blocked = await startCli(apiUrl, credentials, [
    "orgs",
    "delete",
    team.organizationId,
    "--confirm",
    team.organizationId,
  ]).result;
  expect(blocked.stderr).toContain("ORGANIZATION_DELETION_BLOCKED");
  await runCli(apiUrl, credentials, [
    "orgs",
    "delete",
    team.defaultOrganizationId,
    "--confirm",
    team.defaultOrganizationId,
  ]);
  await expect
    .poll(
      async () =>
        decodeOrganization(
          JSON.parse(
            (await runCli(apiUrl, credentials, ["orgs", "get", team.defaultOrganizationId])).stdout,
          ),
        ).data.organization.state,
      { timeout: 10_000 },
    )
    .toBe("deleted");
  expect(
    decodeAuthStatus(JSON.parse((await runCli(apiUrl, credentials, ["auth", "status"])).stdout))
      .data,
  ).toMatchObject({ defaultOrganizationId: team.organizationId });
};

export const verifyOrganizationIsolation = async (apiUrl: string, team: Team, sourceId: string) => {
  const crossOrganization = await startCli(apiUrl, team.outsiderCredentials, [
    "--org",
    team.organizationId,
    "sources",
    "get",
    sourceId,
  ]).result;
  expect(crossOrganization.code).not.toBe(0);
  expect(crossOrganization.stderr).toContain("ORGANIZATION_NOT_FOUND");
  const unknownSource = await startCli(apiUrl, team.outsiderCredentials, [
    "sources",
    "get",
    sourceId,
  ]).result;
  expect(unknownSource.stderr).toContain("SOURCE_NOT_FOUND");
  const outsideBilling = decodeBillingStatus(
    JSON.parse((await runCli(apiUrl, team.outsiderCredentials, ["billing", "status"])).stdout),
  ).data;
  const teamBilling = decodeBillingStatus(
    JSON.parse((await runCli(apiUrl, team.memberCredentials, ["billing", "status"])).stdout),
  ).data;
  expect(outsideBilling).toMatchObject({ plan: "free", credits: { monthly: 30, used: 0 } });
  expect(teamBilling).toMatchObject({
    organizationId: team.organizationId,
    plan: "basic",
    credits: { monthly: 750 },
  });
  const forbidden = await startCli(apiUrl, team.memberCredentials, [
    "billing",
    "contact",
    "not-owner@densio.test",
  ]).result;
  expect(forbidden.stderr).toContain("ORGANIZATION_OWNER_REQUIRED");
};

export const verifyOffboarding = async (
  apiUrl: string,
  ownerCredentials: string,
  team: Team,
  planId: string,
  artifactId: string,
) => {
  const grant = async (credentials: string) =>
    decodeArtifactAuthorization(
      JSON.parse(
        (await runCli(apiUrl, credentials, ["artifacts", "authorize", artifactId])).stdout,
      ),
    ).data.download.url;
  const ownerGrant = await grant(ownerCredentials);
  const memberGrant = await grant(team.memberCredentials);
  const initial = await fetch(memberGrant);
  expect(initial.status).toBe(200);
  expect(initial.headers.get("cache-control")).toBe("private, no-store");
  await initial.arrayBuffer();
  const conditional = await fetch(memberGrant, {
    headers: { "if-none-match": initial.headers.get("etag") ?? "" },
  });
  expect(conditional.status).toBe(304);
  expect(conditional.headers.get("cache-control")).toBe("private, no-store");
  const ranged = await fetch(memberGrant, { headers: { range: "bytes=0-9" } });
  expect(ranged.status).toBe(206);
  expect((await ranged.arrayBuffer()).byteLength).toBe(10);
  const job = decodeJobAccepted(
    JSON.parse(
      (
        await runCli(apiUrl, team.memberCredentials, [
          "plans",
          "execute",
          planId,
          "--idempotency-key",
          "e2e-offboarding",
          "--no-wait",
        ])
      ).stdout,
    ),
  ).data;
  await runCli(apiUrl, ownerCredentials, ["orgs", "members", "remove", team.memberId]);
  expect((await fetch(memberGrant)).status).toBe(404);
  const retainedGrant = await fetch(ownerGrant);
  expect(retainedGrant.status).toBe(200);
  await retainedGrant.arrayBuffer();
  const revokedContext = await startCli(apiUrl, team.memberCredentials, ["jobs", "get", job.jobId])
    .result;
  expect(revokedContext.stderr).toContain("ORGANIZATION_NOT_FOUND");
  const completed = decodeJobStatus(
    JSON.parse(
      (await runCli(apiUrl, ownerCredentials, ["jobs", "wait", job.jobId, "--timeout", "60"]))
        .stdout,
    ),
  ).data;
  expect(completed).toMatchObject({
    state: "succeeded",
    organizationId: team.organizationId,
    createdByUserId: team.memberId,
  });
  if (completed.state !== "succeeded") throw new Error("Admitted job did not survive offboarding.");
  expect(completed.receipt.billing.actualCreditUnits).toBeGreaterThan(0);
  for (const artifact of completed.artifacts)
    await runCli(apiUrl, ownerCredentials, ["artifacts", "delete", artifact.id]);
  await joinOrganization(apiUrl, ownerCredentials, team.memberCredentials, team.organizationId);
  expect((await fetch(memberGrant)).status).toBe(404);
  const ownerBilling = decodeBillingStatus(
    JSON.parse((await runCli(apiUrl, ownerCredentials, ["billing", "status"])).stdout),
  ).data;
  const memberBilling = decodeBillingStatus(
    JSON.parse((await runCli(apiUrl, team.memberCredentials, ["billing", "status"])).stdout),
  ).data;
  expect(memberBilling).toEqual(ownerBilling);
  const membership = decodeOrganization(
    JSON.parse(
      (await runCli(apiUrl, team.memberCredentials, ["orgs", "get", team.organizationId])).stdout,
    ),
  ).data;
  expect(membership.membership.role).toBe("member");
};
