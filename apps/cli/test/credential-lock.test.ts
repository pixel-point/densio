import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { withCredentialLock } from "../src/credential-lock.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("recovers a credential lock left by a terminated process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-credential-lock-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  const lockDirectory = `${credentialsPath}.lock`;
  await mkdir(lockDirectory, { mode: 0o700 });
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const childPid = child.pid;
  if (childPid === undefined) throw new Error("Expected child process ID.");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({ pid: childPid }), {
    mode: 0o600,
  });
  let ran = false;

  await withCredentialLock(credentialsPath, { sleep: async () => undefined }, async () => {
    ran = true;
  });

  expect(ran).toBe(true);
  await expect(access(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("releases the credential lock when the protected action fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-credential-lock-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");

  await expect(
    withCredentialLock(credentialsPath, { sleep: async () => undefined }, async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  await expect(access(`${credentialsPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});
