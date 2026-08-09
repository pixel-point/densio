import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFilePromise = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const bumpScript = join(repositoryRoot, "scripts", "bump-cli-version.sh");
const publishScript = join(repositoryRoot, "scripts", "publish-cli.sh");
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("release scripts", () => {
  it("provides both executable workflows", async () => {
    await expect(access(bumpScript)).resolves.toBeUndefined();
    await expect(access(publishScript)).resolves.toBeUndefined();
  });

  it("rejects unsupported arguments without changing the repository", async () => {
    const before = await readFile(join(repositoryRoot, "apps/cli/package.json"), "utf8");

    await expect(execFilePromise("sh", [bumpScript, "prerelease"])).rejects.toThrow(/usage/i);
    await expect(execFilePromise("sh", [publishScript, "--force"])).rejects.toThrow(/usage/i);

    expect(await readFile(join(repositoryRoot, "apps/cli/package.json"), "utf8")).toBe(before);
  });

  it("bumps and commits one stable version without creating a tag", async () => {
    const directory = await makeReleaseRepository();

    await execFilePromise("sh", [join(directory, "scripts/bump-cli-version.sh"), "0.2.0"], {
      cwd: directory,
    });

    const manifest = JSON.parse(
      await readFile(join(directory, "apps/cli/package.json"), "utf8"),
    ) as { version: string };
    const log = await execFilePromise("git", ["log", "-1", "--pretty=%s"], { cwd: directory });
    const status = await execFilePromise("git", ["status", "--short"], { cwd: directory });
    const tags = await execFilePromise("git", ["tag", "--list"], { cwd: directory });

    expect(manifest.version).toBe("0.2.0");
    expect(log.stdout.trim()).toBe("chore(cli): release v0.2.0");
    expect(status.stdout).toBe("");
    expect(tags.stdout).toBe("");
  });
});

const makeReleaseRepository = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-release-script-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "apps/cli"), { recursive: true });
  await mkdir(join(directory, "scripts"));
  await writeFile(
    join(directory, "apps/cli/package.json"),
    `${JSON.stringify({ name: "densio", version: "0.1.0" }, undefined, 2)}\n`,
  );
  await copyFile(bumpScript, join(directory, "scripts/bump-cli-version.sh"));
  await execFilePromise("git", ["init", "--quiet"], { cwd: directory });
  await execFilePromise("git", ["config", "user.email", "test@densio.local"], { cwd: directory });
  await execFilePromise("git", ["config", "user.name", "Densio Test"], { cwd: directory });
  await execFilePromise("git", ["add", "."], { cwd: directory });
  await execFilePromise("git", ["commit", "--quiet", "-m", "initial"], { cwd: directory });
  return directory;
};
