import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Predicate, Schema } from "effect";

import { credentialLockTimeoutError } from "./cli-errors.ts";
import type { CliRuntime } from "./runtime.ts";

const LockOwnerSchema = Schema.Struct({
  pid: Schema.Int,
});
const decodeLockOwner = Schema.decodeUnknownSync(LockOwnerSchema);
const lockWaitMilliseconds = 25;
const maximumLockAttempts = 200;
const incompleteLockStaleMilliseconds = 5_000;

export const withCredentialLock = async <Value>(
  credentialsPath: string,
  runtime: Pick<CliRuntime, "signal" | "sleep">,
  action: () => Promise<Value>,
) => {
  const lockDirectory = `${credentialsPath}.lock`;
  await acquireLock(lockDirectory, runtime);
  try {
    return await action();
  } finally {
    await rm(lockDirectory, { force: true, recursive: true });
  }
};

const acquireLock = async (
  lockDirectory: string,
  runtime: Pick<CliRuntime, "signal" | "sleep">,
) => {
  for (let attempt = 0; attempt < maximumLockAttempts; attempt += 1) {
    if (runtime.signal?.aborted === true) throw credentialLockTimeoutError();
    if (await tryAcquireLock(lockDirectory)) return;
    if (await lockCanBeRemoved(lockDirectory)) {
      await rm(lockDirectory, { force: true, recursive: true });
      continue;
    }
    await runtime.sleep(lockWaitMilliseconds, runtime.signal);
  }
  throw credentialLockTimeoutError();
};

const tryAcquireLock = async (lockDirectory: string) => {
  const created = await mkdir(lockDirectory, { mode: 0o700 }).then(
    () => true,
    (cause: unknown) => {
      if (nodeErrorCode(cause) === "EEXIST") return false;
      throw cause;
    },
  );
  if (!created) return false;
  const owner = { pid: process.pid };
  await writeFile(join(lockDirectory, "owner.json"), JSON.stringify(owner), {
    flag: "wx",
    mode: 0o600,
  }).catch(async (cause: unknown) => {
    await rm(lockDirectory, { force: true, recursive: true });
    throw cause;
  });
  return true;
};

const lockCanBeRemoved = async (lockDirectory: string) => {
  const owner = await readLockOwner(lockDirectory);
  if (owner !== undefined) return !processIsAlive(owner.pid);
  const lockStat = await stat(lockDirectory).catch(() => undefined);
  return lockStat !== undefined && Date.now() - lockStat.mtimeMs >= incompleteLockStaleMilliseconds;
};

const readLockOwner = async (lockDirectory: string) => {
  const content = await readFile(join(lockDirectory, "owner.json"), "utf8").catch(() => undefined);
  if (content === undefined) return undefined;
  try {
    return decodeLockOwner(JSON.parse(content));
  } catch {
    return undefined;
  }
};

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return nodeErrorCode(cause) !== "ESRCH";
  }
};

const nodeErrorCode = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && typeof cause.code === "string" ? cause.code : undefined;
