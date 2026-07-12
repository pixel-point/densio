import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";

import type { Database } from "../database/database.ts";
import { mediaCommands } from "../database/schema.ts";
import { createCommandPlan } from "../media/command-plan.ts";
import {
  type MediaProcessCommand,
  type MediaProcessError,
  MediaProcessRunner,
} from "../media/process/media-process-runner.ts";
import type { Job } from "./job-worker.ts";

const stderrLimitBytes = 65_536;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export const makeRecordingMediaProcessRunner = (
  database: Database,
  job: Job,
  runner: MediaProcessRunner["Service"],
  ffprobePath: string,
) =>
  MediaProcessRunner.of({
    run: (command) => recordCommand(database, job, runner, ffprobePath, command),
  });

const recordCommand = Effect.fn("JobCommandRecorder.run")(function* (
  database: Database,
  job: Job,
  runner: MediaProcessRunner["Service"],
  ffprobePath: string,
  command: MediaProcessCommand,
) {
  const id = randomUUID();
  const startedAt = yield* Clock.currentTimeMillis;
  const displayCommand = createCommandPlan(command.executable, command.arguments).displayCommand;
  yield* persist(() =>
    database.db
      .insert(mediaCommands)
      .values({
        argumentsJson: JSON.stringify(command.arguments),
        attempt: job.attemptCount,
        displayCommand,
        executable: command.executable,
        id,
        jobId: job.id,
        startedAt,
        tool: command.executable === ffprobePath ? "ffprobe" : "ffmpeg",
      })
      .run(),
  );

  return yield* runner.run(command).pipe(
    Effect.tap((result) => finishCommand(database, id, result.exitCode, result.stderrTail)),
    Effect.tapError((error) => finishFailedCommand(database, id, error)),
    Effect.onInterrupt(() => finishCommand(database, id, null, "")),
  );
});

const finishFailedCommand = (database: Database, id: string, error: MediaProcessError) =>
  finishCommand(database, id, error.exitCode, error.stderrTail);

const finishCommand = Effect.fn("JobCommandRecorder.finish")(function* (
  database: Database,
  id: string,
  exitCode: number | null,
  stderr: string,
) {
  const completedAt = yield* Clock.currentTimeMillis;
  yield* persist(() =>
    database.db
      .update(mediaCommands)
      .set({ completedAt, exitCode, stderrTail: sanitizeMediaStderr(stderr) || null })
      .where(eq(mediaCommands.id, id))
      .run(),
  );
});

export const sanitizeMediaStderr = (stderr: string) =>
  Buffer.from(sanitizeStderr(stderr), "utf8").subarray(-stderrLimitBytes).toString("utf8");

const sanitizeStderr = (stderr: string) =>
  Array.from(stderr.replace(ansiEscapePattern, ""))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 || code === 9 || code === 10 || code === 13;
    })
    .join("");

const persist = (operation: () => unknown) => Effect.sync(operation).pipe(Effect.orDie);
