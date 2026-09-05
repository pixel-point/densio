import { spawn } from "node:child_process";

import type { JobProgress, MediaCodec } from "@densio/shared";
import { Context, Deferred, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { ProcessWriteActivity } from "../../services/process-write-activity.ts";

import { type FfmpegProgressRecord, makeFfmpegProgressParser } from "./ffmpeg-progress.ts";

export interface MediaProcessCommand {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stdoutObserver?: (chunk: string) => void;
  readonly progressContext?: {
    readonly codec?: MediaCodec;
    readonly filename?: string;
    readonly index: number;
    readonly phase: JobProgress["phase"];
    readonly total: number;
    readonly totalDurationSeconds: number;
    readonly variantId?: string;
  };
  readonly progressObserver?: (record: FfmpegProgressRecord) => void;
}

export interface MediaProcessResult {
  readonly exitCode: number;
  readonly stderrTail: string;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}

export class MediaProcessError extends Schema.TaggedErrorClass<MediaProcessError>()(
  "MediaProcessError",
  {
    executable: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    message: Schema.String,
    reason: Schema.Literals(["process-io", "non-zero-exit"]),
    stderrTail: Schema.String,
  },
) {}

interface MediaProcessRunnerOptions {
  readonly concurrency: number;
  readonly forceKillAfterMs?: number;
  readonly stderrLimitBytes?: number;
  readonly stdoutLimitBytes?: number;
}

interface ResolvedRunnerOptions {
  readonly forceKillAfterMs: number;
  readonly stderrLimitBytes: number;
  readonly stdoutLimitBytes: number;
}

export class MediaProcessRunner extends Context.Service<
  MediaProcessRunner,
  {
    run(command: MediaProcessCommand): Effect.Effect<MediaProcessResult, MediaProcessError>;
  }
>()("densio/media/MediaProcessRunner") {
  static readonly layer = (options: MediaProcessRunnerOptions) =>
    Layer.effect(
      MediaProcessRunner,
      Effect.gen(function* () {
        const ownerScope = yield* Effect.scope;
        const semaphore = yield* Semaphore.make(options.concurrency);
        const limits = {
          forceKillAfterMs: options.forceKillAfterMs ?? 5_000,
          stderrLimitBytes: options.stderrLimitBytes ?? 65_536,
          stdoutLimitBytes: options.stdoutLimitBytes ?? 16_777_216,
        };
        const run = Effect.fn("MediaProcessRunner.run")((command: MediaProcessCommand) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const activity = yield* Effect.serviceOption(ProcessWriteActivity);
              const completion = yield* Deferred.make<MediaProcessResult, MediaProcessError>();
              const cancellation = new ProcessCancellation();
              const ownedProcess = semaphore
                .withPermit(
                  Effect.suspend(() =>
                    cancellation.requested
                      ? Effect.fail(processIoError(command.executable))
                      : runProcess(command, limits, cancellation, Option.getOrUndefined(activity)),
                  ),
                )
                .pipe(
                  Effect.interruptible,
                  Effect.onExit((exit) => Deferred.done(completion, exit)),
                  Effect.asVoid,
                );
              yield* Effect.forkIn(ownedProcess, ownerScope, { startImmediately: true });

              return yield* restore(Deferred.await(completion)).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => cancellation.request()).pipe(
                    Effect.andThen(Deferred.await(completion).pipe(Effect.result, Effect.asVoid)),
                  ),
                ),
              );
            }),
          ),
        );

        return MediaProcessRunner.of({ run });
      }),
    );
}

const runProcess = (
  command: MediaProcessCommand,
  limits: ResolvedRunnerOptions,
  cancellation: ProcessCancellation,
  activity: ProcessWriteActivity["Service"] | undefined,
): Effect.Effect<MediaProcessResult, MediaProcessError> =>
  Effect.callback((resume) => {
    const child = spawn(command.executable, command.arguments, {
      cwd: command.cwd,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const completion = Promise.withResolvers<void>();
    let closed = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stderrTail = Buffer.alloc(0);
    let stdout = Buffer.alloc(0);
    let stdoutTruncated = false;
    let releaseActivity: (() => void) | undefined;
    let ioFailed = false;
    const progressParser =
      command.progressObserver === undefined
        ? undefined
        : makeFfmpegProgressParser(command.progressObserver);

    child.stdout.on("data", (chunk: Buffer) => {
      if (command.stdoutObserver !== undefined) {
        command.stdoutObserver(chunk.toString("utf8"));
        return;
      }
      if (progressParser !== undefined) {
        progressParser.push(chunk);
        return;
      }
      const appended = appendBounded(stdout, chunk, limits.stdoutLimitBytes);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-limits.stderrLimitBytes);
    });
    child.once("error", () => {
      ioFailed = true;
    });
    child.once("close", (exitCode) => {
      releaseActivity?.();
      closed = true;
      completion.resolve();
      unsubscribeCancellation();
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (progressParser !== undefined) {
        const appended = appendBounded(
          stdout,
          Buffer.from(progressParser.finish()),
          limits.stdoutLimitBytes,
        );
        stdout = appended.value;
        stdoutTruncated ||= appended.truncated;
      }
      resume(
        ioFailed
          ? Effect.fail(processIoError(command.executable))
          : processExit(command.executable, exitCode, stdout, stdoutTruncated, stderrTail),
      );
    });

    const terminate = () => {
      if (closed) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, limits.forceKillAfterMs);
      forceKillTimer.unref();
    };
    const unsubscribeCancellation = cancellation.subscribe(terminate);
    child.once("spawn", () => {
      try {
        if (child.pid !== undefined && activity !== undefined)
          releaseActivity = activity.track(child.pid);
      } catch {
        ioFailed = true;
        terminate();
      }
    });

    return Effect.promise(async () => {
      unsubscribeCancellation();
      terminate();
      await completion.promise;
    });
  });

const appendBounded = (current: Buffer, chunk: Buffer, limit: number) => {
  const remaining = Math.max(0, limit - current.length);
  return {
    truncated: chunk.length > remaining,
    value: Buffer.concat([current, chunk.subarray(0, remaining)]),
  };
};

class ProcessCancellation {
  readonly #listeners = new Set<() => void>();
  #requested = false;

  get requested() {
    return this.#requested;
  }

  request() {
    if (this.#requested) return;
    this.#requested = true;
    this.#listeners.forEach((listener) => listener());
    this.#listeners.clear();
  }

  subscribe(listener: () => void) {
    if (this.#requested) {
      listener();
      return () => undefined;
    }
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }
}

const processExit = (
  executable: string,
  exitCode: number | null,
  stdout: Buffer,
  stdoutTruncated: boolean,
  stderrTail: Buffer,
) => {
  const stderr = stderrTail.toString("utf8");
  if (exitCode === 0) {
    return Effect.succeed({
      exitCode,
      stderrTail: stderr,
      stdout: stdout.toString("utf8"),
      stdoutTruncated,
    });
  }

  return Effect.fail(
    new MediaProcessError({
      executable,
      exitCode,
      message: `Media process exited with code ${exitCode ?? "unknown"}.`,
      reason: "non-zero-exit",
      stderrTail: stderr,
    }),
  );
};

const processIoError = (executable: string) =>
  new MediaProcessError({
    executable,
    exitCode: null,
    message: "The media process could not be started or read.",
    reason: "process-io",
    stderrTail: "",
  });
