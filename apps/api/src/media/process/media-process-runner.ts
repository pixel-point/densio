import { spawn } from "node:child_process";

import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect";

export interface MediaProcessCommand {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly cwd?: string;
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
>()("ffmpeg-api/media/MediaProcessRunner") {
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
              const completion = yield* Deferred.make<MediaProcessResult, MediaProcessError>();
              const cancellation = new ProcessCancellation();
              const ownedProcess = semaphore
                .withPermit(
                  Effect.suspend(() =>
                    cancellation.requested
                      ? Effect.fail(processIoError(command.executable))
                      : runProcess(command, limits, cancellation),
                  ),
                )
                .pipe(
                  Effect.exit,
                  Effect.flatMap((exit) => Deferred.done(completion, exit)),
                  Effect.asVoid,
                );
              yield* Effect.forkIn(ownedProcess, ownerScope, { startImmediately: true });

              return yield* restore(Deferred.await(completion)).pipe(
                Effect.onInterrupt(() => Effect.sync(() => cancellation.request())),
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
): Effect.Effect<MediaProcessResult, MediaProcessError> =>
  Effect.callback((resume) => {
    const child = spawn(command.executable, command.arguments, {
      cwd: command.cwd,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let closed = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stderrTail = Buffer.alloc(0);
    let stdout = Buffer.alloc(0);
    let stdoutTruncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = Math.max(0, limits.stdoutLimitBytes - stdout.length);
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
      stdoutTruncated ||= chunk.length > remaining;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-limits.stderrLimitBytes);
    });
    child.once("error", () => {
      closed = true;
      unsubscribeCancellation();
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resume(Effect.fail(processIoError(command.executable)));
    });
    child.once("close", (exitCode) => {
      closed = true;
      unsubscribeCancellation();
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      resume(processExit(command.executable, exitCode, stdout, stdoutTruncated, stderrTail));
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

    return Effect.sync(() => {
      unsubscribeCancellation();
      terminate();
    });
  });

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
