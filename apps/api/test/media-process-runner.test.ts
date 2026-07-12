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

  it("escalates interrupted processes from SIGTERM to SIGKILL", async () => {
    const logPath = await createLogPath();
    const startedAt = Date.now();
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        MediaProcessRunner.use((runner) =>
          runner.run({
            ...command(logPath, "400", "0"),
            arguments: [fixturePath, logPath, "400", "0", "", "ignore-term"],
          }),
        ),
      );
      yield* waitForProcessStart(logPath);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 1, forceKillAfterMs: 25 })));

    await Effect.runPromise(program);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect((await readEvents(logPath)).map(({ event }) => event)).toEqual(["start"]);
  });
});

const createLogPath = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-process-"));
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
  readonly pid: number;
}

const readEvents = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ProcessEvent);

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
