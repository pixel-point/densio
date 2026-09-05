import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Clock, Effect } from "effect";

import type { Database } from "../database/database.ts";
import { transitionJob } from "../database/job-transition-repository.ts";
import { mediaCommands } from "../database/schema.ts";
import { createCommandPlan } from "../media/command-plan.ts";
import {
  type MediaProcessCommand,
  type MediaProcessError,
  MediaProcessRunner,
} from "../media/process/media-process-runner.ts";
import type { FfmpegProgressRecord } from "../media/process/ffmpeg-progress.ts";
import type { Job } from "./job-worker.ts";

const stderrLimitBytes = 65_536;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export const makeRecordingMediaProcessRunner = (
  database: Database,
  job: Job,
  runner: MediaProcessRunner["Service"],
  ffprobePath: string,
) => {
  const activeOutputs = new Map<
    number,
    NonNullable<MediaProcessCommand["progressContext"]> & {
      readonly etaSeconds?: { readonly maximum: number; readonly minimum: number };
      readonly processedDurationSeconds: number;
    }
  >();
  return MediaProcessRunner.of({
    run: (command) => recordCommand(database, job, runner, ffprobePath, command, activeOutputs),
  });
};

const recordCommand = Effect.fn("JobCommandRecorder.run")(function* (
  database: Database,
  job: Job,
  runner: MediaProcessRunner["Service"],
  ffprobePath: string,
  command: MediaProcessCommand,
  activeOutputs: Map<
    number,
    NonNullable<MediaProcessCommand["progressContext"]> & {
      readonly etaSeconds?: { readonly maximum: number; readonly minimum: number };
      readonly processedDurationSeconds: number;
    }
  >,
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

  const observedCommand = withProgressObserver(database, job, command, activeOutputs);
  return yield* runner.run(observedCommand).pipe(
    Effect.tap((result) => finishCommand(database, id, result.exitCode, result.stderrTail)),
    Effect.tapError((error) => finishFailedCommand(database, id, error)),
    Effect.onInterrupt(() => finishCommand(database, id, null, "")),
  );
});

const withProgressObserver = (
  database: Database,
  job: Job,
  command: MediaProcessCommand,
  activeOutputs: Map<
    number,
    NonNullable<MediaProcessCommand["progressContext"]> & {
      readonly etaSeconds?: { readonly maximum: number; readonly minimum: number };
      readonly processedDurationSeconds: number;
    }
  >,
): MediaProcessCommand => {
  if (command.progressContext === undefined) return command;
  const progressContext = command.progressContext;
  return {
    ...command,
    progressObserver: (record) => {
      command.progressObserver?.(record);
      observeJobProgress(database, job, progressContext, record, activeOutputs);
    },
  };
};

const observeJobProgress = (
  database: Database,
  job: Job,
  context: NonNullable<MediaProcessCommand["progressContext"]>,
  record: FfmpegProgressRecord,
  activeOutputs: Map<
    number,
    NonNullable<MediaProcessCommand["progressContext"]> & {
      readonly etaSeconds?: { readonly maximum: number; readonly minimum: number };
      readonly processedDurationSeconds: number;
    }
  >,
) => {
  const previousPhase = activeOutputs.values().next().value?.phase;
  if (previousPhase !== undefined && previousPhase !== context.phase) activeOutputs.clear();
  const processedDurationSeconds = Math.min(
    context.totalDurationSeconds,
    record.progress === "end"
      ? context.totalDurationSeconds
      : (record.outTimeSeconds ?? activeOutputs.get(context.index)?.processedDurationSeconds ?? 0),
  );
  const remainingSeconds = Math.max(0, context.totalDurationSeconds - processedDurationSeconds);
  const etaSeconds =
    record.speed === undefined || record.speed <= 0 || remainingSeconds === 0
      ? undefined
      : {
          maximum: (remainingSeconds / record.speed) * 1.25,
          minimum: (remainingSeconds / record.speed) * 0.75,
        };
  activeOutputs.set(context.index, {
    ...context,
    ...(etaSeconds === undefined ? {} : { etaSeconds }),
    processedDurationSeconds,
  });
  const outputs = [...activeOutputs.values()]
    .toSorted(({ index: left }, { index: right }) => left - right)
    .map(({ phase: _, ...output }) => output);
  const completedFraction =
    outputs.reduce(
      (total, output) => total + output.processedDurationSeconds / output.totalDurationSeconds,
      0,
    ) / context.total;
  const band = progressBand(context.phase);
  transitionJob(database, {
    jobId: job.id,
    now: Date.now(),
    command: {
      type: "progress",
      activeOutputs: outputs,
      attempt: job.attemptCount,
      percent: Math.min(95, Math.round(band.start + completedFraction * band.width)),
      phase: context.phase,
      workerId: job.leaseOwner ?? "",
    },
  });
};

const progressBand = (phase: NonNullable<MediaProcessCommand["progressContext"]>["phase"]) => {
  if (phase === "preparing") return { start: 10, width: 10 };
  if (phase === "encoding") return { start: 20, width: 65 };
  if (phase === "measuring") return { start: 85, width: 10 };
  return { start: 10, width: 85 };
};

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
