import { afterEach, describe, expect, it } from "vitest";

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

describe("skill command", () => {
  it("retrieves and validates the current skill bundle", async () => {
    const requests: Array<string | undefined> = [];
    const server = await startCliServer((request, response) => {
      requests.push(request.url);
      sendEnvelope(response, bundle);
    });
    const capture = await makeCliCapture();

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "skill"],
      capture.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(requests).toEqual(["/v1/skill"]);
    expect(JSON.parse(capture.stdout())).toEqual({
      correlationId: "test-correlation",
      data: bundle,
      ok: true,
      schemaVersion: 1,
    });
    expect(capture.stderr()).toBe("");
    await server.close();
  });

  it("rejects positional arguments without making a request", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(["--json", "skill", "extra"], capture.dependencies);

    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.stderr()).detail).toBe("skill accepts no arguments.");
  });
});
