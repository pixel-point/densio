import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const execFilePromise = promisify(execFile);
const cliDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxExecutable = resolve(cliDirectory, "../../node_modules/.bin/tsx");

describe("CLI entrypoint", () => {
  it("runs the real command parser", async () => {
    const result = await execFilePromise(tsxExecutable, ["src/index.ts", "--help"], {
      cwd: cliDirectory,
    });

    expect(result.stdout).toContain("agent-first video processing");
    expect(result.stderr).toBe("");
  });
});
