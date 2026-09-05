import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/media-process-fixture.mjs", import.meta.url));
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("media process runner", () => {
  it("enforces one global concurrency limit across child processes", async () => {
    const logPath = await createLogPath();
    const program = Effect.all(
      Array.from({ length: 4 }, () =>
        MediaProcessRunner.use((runner) => runner.run(command(logPath, "40", "0", "", "barrier"))),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 2 })));

    await Effect.runPromise(program);

    expect(maximumConcurrency(await readEvents(logPath))).toBe(2);
  });

  it("returns bounded stderr and a typed failure for non-zero exits", async () => {
    const logPath = await createLogPath();
    const error = await Effect.runPromise(
      MediaProcessRunner.use((runner) => runner.run(command(logPath, "0", "7", "0123456789"))).pipe(
        Effect.provide(MediaProcessRunner.layer({ concurrency: 1, stderrLimitBytes: 6 })),
        Effect.flip,
      ),
    );

    expect(error).toMatchObject({
      _tag: "MediaProcessError",
      exitCode: 7,
      reason: "non-zero-exit",
      stderrTail: "456789",
    });
  });

  it("keeps a permit until an interrupted process exits", async () => {
    const logPath = await createLogPath();
    const program = Effect.gen(function* () {
      const runner = yield* MediaProcessRunner;
      const fiber = yield* Effect.forkChild(
        runner.run({
          ...command(logPath, "30000", "0"),
          arguments: [fixturePath, logPath, "30000", "0", "", "ignore-term"],
        }),
      );
      yield* waitForProcessStart(logPath);
      const firstPid = (yield* readProcessEvents(logPath))[0]?.pid;
      if (firstPid === undefined) return yield* Effect.die("First child PID was not recorded");
      yield* Fiber.interrupt(fiber);
      expect(() => process.kill(firstPid, 0)).toThrow();
      yield* runner.run({
        ...command(logPath, "0", "0"),
        arguments: [fixturePath, logPath, "0", "0", "", "default", String(firstPid)],
      });

      return { events: yield* readProcessEvents(logPath) };
    }).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 1, forceKillAfterMs: 25 })));

    const result = await Effect.runPromise(program);

    expect(result.events.map(({ event }) => event)).toEqual(["start", "start", "end"]);
    expect(result.events[1]?.peerAlive).toBe(false);
  });

  it("streams FFmpeg progress records without leaking protocol text into stdout", async () => {
    const logPath = await createLogPath();
    const records: Array<unknown> = [];
    const progress = [
      "frame=10",
      "out_time_us=2000000",
      "speed=2x",
      "progress=continue",
      "diagnostic=keep",
      "frame=20",
      "out_time_us=4000000",
      "progress=end",
      "",
    ].join("\n");
    const result = await Effect.runPromise(
      MediaProcessRunner.use((runner) =>
        runner.run({
          ...command(logPath, "0", "0"),
          arguments: [fixturePath, logPath, "0", "0", "", "default", "", progress],
          progressObserver: (record) => records.push(record),
        }),
      ).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 1 }))),
    );

    expect(records).toEqual([
      { frame: 10, outTimeSeconds: 2, progress: "continue", speed: 2 },
      { frame: 20, outTimeSeconds: 4, progress: "end" },
    ]);
    expect(result.stdout).toBe("diagnostic=keep\n");
    expect(result.stdout).not.toContain("out_time_us");
  });
});

it("waits for child process exit when the runner's owning scope closes", async () => {
  const logPath = await createLogPath();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* MediaProcessRunner;
      const fiber = yield* Effect.forkDetach(
        runner.run(command(logPath, "30000", "0", "", "ignore-term")),
      );
      yield* waitForProcessStart(logPath);
      return { fiber, pid: (yield* readProcessEvents(logPath))[0]?.pid };
    }).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 1, forceKillAfterMs: 25 }))),
  );
  if (result.pid === undefined) throw new Error("Child PID was not recorded");
  const wasAlive = (() => {
    try {
      process.kill(result.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  await Effect.runPromise(Fiber.interrupt(result.fiber));
  expect(wasAlive).toBe(false);
});

const createLogPath = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-process-"));
  temporaryDirectories.push(directory);
  return join(directory, "events.ndjson");
};

const command = (
  logPath: string,
  delay: string,
  exitCode: string,
  stderr = "",
  signalMode = "default",
) => ({
  arguments: [fixturePath, logPath, delay, exitCode, stderr, signalMode],
  executable: process.execPath,
});

interface ProcessEvent {
  readonly event: "start" | "end";
  readonly peerAlive?: boolean;
  readonly pid: number;
}

const readEvents = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ProcessEvent);

const readProcessEvents = (path: string) =>
  Effect.tryPromise({
    catch: () => new Error("Could not read process events"),
    try: () => readEvents(path),
  }).pipe(Effect.orDie);

const waitForProcessStart = (path: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const started = yield* Effect.tryPromise({
        catch: () => false,
        try: async () => (await readFile(path, "utf8")).includes('"event":"start"'),
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (started) return;
      yield* Effect.sleep(5);
    }
    return yield* Effect.die("Child process did not start in time");
  });

const maximumConcurrency = (events: ReadonlyArray<ProcessEvent>) =>
  events.reduce(
    (state, event) => {
      const active = state.active + (event.event === "start" ? 1 : -1);
      return { active, maximum: Math.max(state.maximum, active) };
    },
    { active: 0, maximum: 0 },
  ).maximum;
