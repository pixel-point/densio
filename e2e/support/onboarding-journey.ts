import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  CapabilitiesSchema,
  OrganizationListResponseSchema,
  SkillSelectionSchema,
  successEnvelope,
} from "@densio/shared";
import { Schema } from "effect";
import { expect } from "vitest";

import {
  decodeArtifactMaterialization,
  decodeAuthStatus,
  decodePreparedSource,
} from "./contracts.ts";
import { probeVideo, runCli } from "./driver.ts";

const decodeSkill = Schema.decodeUnknownSync(successEnvelope(SkillSelectionSchema));
const decodeOrganizations = Schema.decodeUnknownSync(
  successEnvelope(OrganizationListResponseSchema),
);
const decodeCapabilities = Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema));

export const loadFirstUseInstructions = async (apiUrl: string, credentialsPath: string) => {
  const response = await runCli(apiUrl, credentialsPath, ["skill"]);
  const skill = decodeSkill(JSON.parse(response.stdout)).data;
  expect(Buffer.byteLength(response.stdout)).toBeLessThan(7500);
  const content = skill.files[0]?.content ?? "";
  const command = (fragment: string, variables: Readonly<Record<string, string>> = {}) => {
    const line = content
      .split("\n")
      .find(
        (candidate) =>
          candidate.startsWith("npx --yes densio@CLI_VERSION ") && candidate.includes(fragment),
      );
    if (line === undefined) throw new Error(`First-use skill has no command for ${fragment}.`);
    return line
      .slice("npx --yes densio@CLI_VERSION ".length)
      .split(" ")
      .map((argument) => variables[argument] ?? argument);
  };
  const status = await runCli(apiUrl, credentialsPath, command("auth status"));
  expect(decodeAuthStatus(JSON.parse(status.stdout)).data.authenticated).toBe(false);
  return { command, skill };
};

export const verifyFirstCompression = async (
  apiUrl: string,
  credentialsPath: string,
  sourcePath: string,
  directory: string,
  instructions: Awaited<ReturnType<typeof loadFirstUseInstructions>>,
) => {
  const { command, skill } = instructions;
  const listed = await runCli(apiUrl, credentialsPath, command("orgs list"));
  const organizations = decodeOrganizations(JSON.parse(listed.stdout)).data;
  expect(organizations.organizations).toHaveLength(1);
  const organization = organizations.organizations[0];
  if (organization === undefined) throw new Error("First signup did not create a workspace.");
  const variables = { ORG_ID: organization.organization.organizationId };
  const capabilities = await runCli(apiUrl, credentialsPath, command(" capabilities", variables));
  expect(decodeCapabilities(JSON.parse(capabilities.stdout)).data.plan).toBe("free");
  const input = await readFile(sourcePath);
  const inspected = await runCli(
    apiUrl,
    credentialsPath,
    command("inspect FILE", {
      ...variables,
      FILE: sourcePath,
      SOURCE_KEY: "onboarding-source",
    }),
  );
  const source = decodePreparedSource(JSON.parse(inspected.stdout)).data;
  expect(source.state).toBe("ready");
  const compressed = await runCli(
    apiUrl,
    credentialsPath,
    command("jobs create", {
      ...variables,
      SOURCE_ID: source.sourceId,
      JOB_KEY: "onboarding-compress",
      OUTPUT_DIR: join(await realpath(directory), "first video"),
    }),
  );
  const materialized = decodeArtifactMaterialization(JSON.parse(compressed.stdout)).data;
  expect(materialized.files).toHaveLength(2);
  expect(materialized.job.state).toBe("succeeded");
  if (materialized.job.state !== "succeeded")
    throw new Error("First compression did not complete.");
  expect(materialized.job.receipt.billing.actualCredits).toBeGreaterThan(0);
  expect(materialized.job.receipt.intent.sourceId).toBe(source.sourceId);
  const codecs = await Promise.all(
    materialized.files.map(async (file) => {
      const bytes = await readFile(file.path);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      expect(file.verified).toBe(true);
      return (await probeVideo(file.path)).codec;
    }),
  );
  expect(codecs.toSorted()).toEqual(["hevc", "vp9"]);
  expect(await readFile(sourcePath)).toEqual(input);
  expect(materialized.htmlPath).toBeDefined();
  const reference = await runCli(
    apiUrl,
    credentialsPath,
    command("skill references/commands.md", {
      SKILL_VERSION: skill.skillVersion,
    }),
  );
  const selected = decodeSkill(JSON.parse(reference.stdout)).data;
  expect(selected.cliVersion).toBe(skill.cliVersion);
  expect(selected.files.map(({ path }) => path)).toEqual(["references/commands.md"]);
  expect(selected.skillVersion).toBe(skill.skillVersion);
  await runCli(apiUrl, credentialsPath, [
    "--org",
    variables.ORG_ID,
    "sources",
    "delete",
    source.sourceId,
  ]);
  await Promise.all(
    materialized.files.map(({ artifactId }) =>
      runCli(apiUrl, credentialsPath, [
        "--org",
        variables.ORG_ID,
        "artifacts",
        "delete",
        artifactId,
      ]),
    ),
  );
};
