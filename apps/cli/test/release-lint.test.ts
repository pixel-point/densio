import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFilePromise = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const temporaryDirectories: Array<string> = [];
const releaseDirectories = ["apps/api", "apps/cli", "packages/shared", "e2e", "scripts"];
const oversizedFunction = `export function oversized() {\n${"  console.log('line');\n".repeat(101)}}\n`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CLI release lint", () => {
  it("allows an independent website lint failure", async () => {
    const directory = await makeLintRepository();
    await writeFile(join(directory, "apps/website/example.ts"), oversizedFunction);

    await expect(execFilePromise("pnpm", ["lint"], { cwd: directory })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("error"),
    });
  });

  it.each(releaseDirectories)("enforces the function limit in %s", async (target) => {
    const directory = await makeLintRepository();
    await writeFile(join(directory, target, "example.ts"), oversizedFunction);

    await expect(execFilePromise("pnpm", ["lint"], { cwd: directory })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("max-lines-per-function"),
    });
  });
});

const makeLintRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-release-lint-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    [...releaseDirectories, "apps/website"].map((target) =>
      mkdir(join(directory, target), { recursive: true }),
    ),
  );
  const workspace = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly packageManager: string;
    readonly scripts: Record<string, string>;
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      packageManager: workspace.packageManager,
      scripts: { lint: workspace.scripts["lint:cli-release"] ?? workspace.scripts.lint },
    }),
  );
  await copyFile(join(repositoryRoot, ".oxlintrc.json"), join(directory, ".oxlintrc.json"));
  await symlink(join(repositoryRoot, "node_modules"), join(directory, "node_modules"));
  await writeFile(join(directory, "apps/cli/index.ts"), "export const release = true;\n");
  return directory;
};
