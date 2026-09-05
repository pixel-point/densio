import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { CLI_HELP } from "../src/help.ts";
import { COMMAND_CATALOG } from "../src/command-catalog.ts";
import { parsePlanCreate } from "../src/plan-options.ts";

const referenceDirectory = new URL("../../../skill-bundle/references/", import.meta.url);
const commandReferences = async () => {
  const names = await readdir(referenceDirectory);
  const contents = await Promise.all(
    names.map((name) => readFile(new URL(name, referenceDirectory), "utf8")),
  );
  return contents.join("\n").replaceAll("npx --yes densio@CLI_VERSION", "npx densio");
};
const workflowsReference = fileURLToPath(new URL("workflows.md", referenceDirectory));
const entrypoint = fileURLToPath(new URL("../../../skill-bundle/entrypoint.md", import.meta.url));
const errorsReference = fileURLToPath(
  new URL("../../../skill-bundle/references/errors.md", import.meta.url),
);
const organizationsReference = fileURLToPath(
  new URL("../../../skill-bundle/references/organizations.md", import.meta.url),
);

it("documents explicit 10-bit requests, matching comparison depth, and verification failures", async () => {
  const [commands, errors, skill] = await Promise.all([
    commandReferences(),
    readFile(errorsReference, "utf8"),
    readFile(workflowsReference, "utf8"),
  ]);
  expect(CLI_HELP).toContain("--bit-depth");
  expect(commands).toContain("--bit-depth 10");
  expect(commands).toContain('"bitDepth": 10');
  expect(skill).toContain("explicitly requests 10-bit");
  expect(skill).toContain("same bit depth");
  expect(errors).toContain("OUTPUT_BIT_DEPTH_MISMATCH");
});

it("keeps recovery authority and delayed cleanup explicit in help and runtime guidance", async () => {
  const [organizations, errors, skill] = await Promise.all([
    readFile(organizationsReference, "utf8"),
    readFile(errorsReference, "utf8"),
    readFile(workflowsReference, "utf8"),
  ]);
  for (const command of [
    "api-admin billing inspect ORG_ID",
    "api-admin billing reconcile ORG_ID",
  ]) {
    expect(organizations).toContain(command);
    expect(errors).toContain(command);
  }
  expect(organizations).toContain("not end-user CLI commands");
  expect(organizations).toContain("without creating a replacement checkout");
  expect(skill).toContain("waits for active upload/job writers");
  expect(CLI_HELP).toContain("platform operator");
  expect(CLI_HELP).toContain("physical cleanup waits for active writers");
});

it("keeps every agent-skill flag discoverable in CLI help", async () => {
  const reference = await commandReferences();
  const documentedFlags = new Set(reference.match(/--[a-z][a-z-]*/g) ?? []);

  expect([...documentedFlags].filter((flag) => !CLI_HELP.includes(flag))).toEqual([]);
  expect(reference).toContain("artifacts download ARTIFACT_ID");
  expect(CLI_HELP).toContain("artifacts download ARTIFACT_ID");
  reference
    .split("\n")
    .map((line) => line.replace(" --org ORG_ID", ""))
    .filter((line) => line.startsWith("npx densio --json plans create "))
    .forEach((line) => {
      expect(() =>
        parsePlanCreate(line.slice("npx densio --json plans create ".length).split(" ")),
      ).not.toThrow();
    });
  expect(reference).not.toMatch(/SIGNED_URL|decide-frame-rate|provenance\.completeness/);
});

it("documents every CLI command, including explicit organization selection and billing keys", async () => {
  const reference = await commandReferences();
  Object.keys(COMMAND_CATALOG).forEach((command) => {
    const example = command.replace(/^(plans|jobs) create /, "$1 create SOURCE_ID ");
    expect(reference, command).toContain(example);
  });
  expect(reference).toContain("--org ORG_ID");
  const subscriptions = reference
    .split("\n")
    .filter((line) => line.startsWith("npx ") && line.includes("billing subscribe"));
  expect(subscriptions.length).toBeGreaterThan(0);
  subscriptions.forEach((line) => expect(line).toContain("--idempotency-key"));
});

it("teaches agents direct submission, optional previews, HLS, and the and matrix decision flow", async () => {
  const [commands, errors, skill] = await Promise.all([
    commandReferences(),
    readFile(errorsReference, "utf8"),
    readFile(workflowsReference, "utf8"),
  ]);

  expect(skill.toLowerCase()).toContain("upload once");
  expect(skill).toContain("immutable execution plan");
  expect(skill).toContain("exact quote");
  expect(skill).toContain("jobs create SOURCE_ID WORKFLOW");
  expect(skill).toContain("MEDIA_DECISION_REQUIRED");
  expect(skill).toContain("references/hls.md");
  expect(commands).toContain("--options-file");
  expect(skill).toContain("Pareto");
  expect(commands).toContain("inspect input.mp4");
  expect(commands).toContain("plans create SOURCE_ID");
  expect(commands).toContain("plans execute PLAN_ID --idempotency-key");
  expect(commands).toContain("--matrix vp9:");
  expect(commands).toContain("jobs events JOB_ID");
  expect(commands).toContain("artifacts materialize JOB_ID");
  expect(errors).toContain("SOURCE_NOT_FOUND");
  expect(errors).toContain("EXECUTION_PLAN_NOT_FOUND");
  expect(errors).toContain("OUTPUT_SIZE_LIMIT_EXCEEDED");
});

it("documents cancellable waiting, terminal event draining and local validation", async () => {
  const [commands, errors] = await Promise.all([
    commandReferences(),
    readFile(errorsReference, "utf8"),
  ]);
  expect(CLI_HELP).toContain("Bound polling, HTTP and token refresh");
  expect(CLI_HELP).toContain("Drain persisted events");
  expect(commands).toContain("one deadline");
  expect(commands).toContain("before authentication");
  expect(errors).toContain("api-admin storage reconcile ORG_ID OBJECT_ID");
});

it("keeps first-use instructions small and uses a pinned CLI in every runtime example", async () => {
  const directory = new URL("../../../skill-bundle/references/", import.meta.url);
  const names = await readdir(directory);
  const skill = await readFile(entrypoint, "utf8");
  const references = await Promise.all(
    names.map((name) => readFile(new URL(name, directory), "utf8")),
  );

  expect(Buffer.byteLength(skill)).toBeLessThan(6000);
  expect(skill).toContain("auth status");
  expect(skill).toContain("auth login EMAIL");
  expect(skill).toContain("--output-dir OUTPUT_DIR");
  expect(skill).toContain("--skill-version SKILL_VERSION");
  expect(skill).not.toContain(
    "Read [references/commands.md](references/commands.md) before constructing commands",
  );
  [skill, ...references].forEach((markdown) => {
    expect(markdown).not.toMatch(/npx densio\b/);
    expect(markdown).not.toMatch(/densio@latest/);
  });
});
