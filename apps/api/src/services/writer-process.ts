import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const writerProcessIdentity = (pid: number) => {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (startTicks === undefined) throw new Error("Missing process start identity.");
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${startTicks}`;
  }
  // macOS development: PID plus kernel-reported start time, never an expiring lease.
  const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
  if (started === "") throw new Error("Missing process start identity.");
  return started;
};

export const writerIsAlive = (pid: number, identity: string) => {
  try {
    process.kill(pid, 0);
    return writerProcessIdentity(pid) === identity;
  } catch (error) {
    // A reused PID is distinguishable by start identity. Permission errors do not
    // prove the old writer exited and must never unlock physical deletion.
    return !(
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "ENOENT")
    );
  }
};
