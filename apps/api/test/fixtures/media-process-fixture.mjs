import { appendFileSync, readFileSync } from "node:fs";

const [
  logPath,
  delayInput,
  exitCodeInput,
  stderrText = "",
  signalMode = "default",
  peerPidInput,
  stdoutText = "",
] = process.argv.slice(2);
const delay = Number(delayInput);
const exitCode = Number(exitCodeInput);
const peerAlive = peerPidInput === undefined ? undefined : isProcessAlive(Number(peerPidInput));

if (signalMode === "ignore-term") process.on("SIGTERM", () => undefined);
appendFileSync(logPath, `${JSON.stringify({ event: "start", peerAlive, pid: process.pid })}\n`);
process.stderr.write(stderrText);
process.stdout.write(stdoutText);

if (signalMode === "barrier") await waitForConcurrentPeer();

setTimeout(() => {
  appendFileSync(logPath, `${JSON.stringify({ event: "end", pid: process.pid })}\n`);
  process.exit(exitCode);
}, delay);

function waitForConcurrentPeer() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      const active = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .reduce((count, event) => count + (event.event === "start" ? 1 : -1), 0);
      if (active >= 2) return resolve();
      if (Date.now() - startedAt >= 2_000) {
        return reject(new Error("Timed out waiting for a concurrent child process"));
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
