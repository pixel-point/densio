import { afterEach, describe, expect, it } from "vitest";
import { version } from "../package.json";

import { runCli } from "../src/cli.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

const bundle = {
  entrypoint: "SKILL.md",
  files: [
    { content: "# Densio\n", path: "SKILL.md", sha256: "a".repeat(64) },
    {
      content: "# Commands\n",
      path: "references/commands.md",
      sha256: "b".repeat(64),
    },
  ],
  skillVersion: `sha256:${"c".repeat(64)}`,
};

const invokeSkill = async (argumentsInput: ReadonlyArray<string> = [], json = true) => {
  const server = await startCliServer((_request, response) => sendEnvelope(response, bundle));
  const capture = await makeCliCapture();
  const exitCode = await runCli(
    [...(json ? ["--json"] : []), "--api-url", server.url, "skill", ...argumentsInput],
    capture.dependencies,
  );
  await server.close();
  return { ...capture, exitCode };
};

describe("skill command", () => {
  it("returns only the entrypoint with a reference index and the executing CLI version", async () => {
    const capture = await invokeSkill();

    expect(capture.exitCode).toBe(0);
    expect(JSON.parse(capture.stdout())).toEqual({
      correlationId: "test-correlation",
      data: {
        cliVersion: version,
        entrypoint: "SKILL.md",
        files: [bundle.files[0]],
        references: [{ path: "references/commands.md", sha256: "b".repeat(64) }],
        skillVersion: bundle.skillVersion,
      },
      ok: true,
      schemaVersion: 1,
    });
    expect(capture.stdout()).not.toContain("# Commands");
    expect(capture.stderr()).toBe("");
  });

  it("loads one reference from the expected bundle without repeating other content", async () => {
    const capture = await invokeSkill([
      "references/commands.md",
      "--skill-version",
      bundle.skillVersion,
    ]);

    expect(capture.exitCode).toBe(0);
    expect(JSON.parse(capture.stdout()).data.files).toEqual([bundle.files[1]]);
    expect(capture.stdout()).not.toContain("# Densio");
  });

  it("refuses changed instructions with a recovery action and no partial success output", async () => {
    const capture = await invokeSkill([
      "references/commands.md",
      "--skill-version",
      `sha256:${"d".repeat(64)}`,
    ]);

    expect(capture.exitCode).not.toBe(0);
    expect(capture.stdout()).toBe("");
    expect(JSON.parse(capture.stderr())).toMatchObject({
      code: "SKILL_VERSION_CHANGED",
      status: 409,
      suggestedAction: expect.stringContaining("skill"),
    });
  });

  it("reports a missing reference without returning the full bundle", async () => {
    const capture = await invokeSkill(["references/missing.md"]);

    expect(capture.exitCode).toBe(2);
    expect(capture.stdout()).toBe("");
    expect(JSON.parse(capture.stderr()).detail).toContain("not in the current skill");
  });

  it("keeps human output limited to the selected document and names the CLI version", async () => {
    const capture = await invokeSkill([], false);

    expect(capture.exitCode).toBe(0);
    expect(capture.stdout()).toContain(`# Densio`);
    expect(capture.stdout()).toContain(`densio@${version}`);
    expect(capture.stdout()).not.toContain("# Commands");
  });
});

it.each([
  ["extra"],
  ["../secret.md"],
  ["references/commands.md", "SKILL.md"],
  ["--skill-version", "latest"],
  ["--skill-version"],
  ["--skill-version", bundle.skillVersion, "--skill-version", bundle.skillVersion],
])(
  "rejects invalid skill arguments before requesting instructions: %j",
  async (...argumentsInput) => {
    const capture = await makeCliCapture();
    const exitCode = await runCli(["--json", "skill", ...argumentsInput], {
      ...capture.dependencies,
      fetch: async () => {
        throw new Error("Invalid arguments must not request the API.");
      },
    });

    expect(exitCode).toBe(2);
    expect(capture.stdout()).toBe("");
    expect(JSON.parse(capture.stderr()).code).toBe("CLI_USAGE_ERROR");
  },
);
