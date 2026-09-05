import type { CliRuntime } from "./runtime.ts";

type PollDecision<Value> =
  | { readonly kind: "complete"; readonly value: Value }
  | { readonly delayMilliseconds: number; readonly kind: "pending" };

interface PollingOptions<Response, Value> {
  readonly deadlineAt?: number;
  readonly decide: (response: Response) => PollDecision<Value>;
  readonly initialDelayMilliseconds: number;
  readonly interruptedError: () => Error;
  readonly isRetryableFailure: (cause: unknown) => boolean;
  readonly maximumTransientFailures?: number;
  readonly poll: (signal: AbortSignal) => Promise<Response>;
  readonly runtime: Pick<CliRuntime, "now" | "signal" | "sleep">;
  readonly timeoutError: () => Error;
}

export const pollUntilComplete = async <Response, Value>(
  options: PollingOptions<Response, Value>,
) => {
  const deadline = new AbortController();
  const signal = AbortSignal.any([
    deadline.signal,
    ...(options.runtime.signal ? [options.runtime.signal] : []),
  ]);
  const stopTimer = scheduleDeadline(options.deadlineAt, options.runtime.now, deadline);
  const stopped = () =>
    options.runtime.signal?.aborted ? options.interruptedError() : options.timeoutError();
  try {
    return await runPolling(options, signal, stopped);
  } finally {
    stopTimer();
  }
};

const runPolling = async <Response, Value>(
  options: PollingOptions<Response, Value>,
  signal: AbortSignal,
  stopped: () => Error,
) => {
  const remaining = () =>
    options.deadlineAt === undefined ? Infinity : options.deadlineAt - options.runtime.now();
  let delay = options.initialDelayMilliseconds;
  let failures = 0;
  while (!signal.aborted && remaining() > 0) {
    await abortably(
      () => options.runtime.sleep(Math.min(delay, remaining()), signal),
      signal,
      stopped,
    );
    if (signal.aborted || remaining() <= 0) break;
    const response = await abortably(() => options.poll(signal), signal, stopped).catch(
      (cause: unknown) => {
        if (signal.aborted || remaining() <= 0) throw stopped();
        if (
          !options.isRetryableFailure(cause) ||
          failures >= (options.maximumTransientFailures ?? 3)
        )
          throw cause;
        failures += 1;
        return undefined;
      },
    );
    if (signal.aborted || remaining() <= 0) break;
    if (response === undefined) {
      delay = 1_000 * 2 ** (failures - 1);
      continue;
    }
    failures = 0;
    const decision = options.decide(response);
    if (decision.kind === "complete") return decision.value;
    delay = decision.delayMilliseconds;
  }
  throw stopped();
};

const abortably = <Value>(
  action: () => Promise<Value>,
  signal: AbortSignal,
  stopped: () => Error,
) => {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(stopped());
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw stopped();
        return action();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
};

const scheduleDeadline = (
  deadlineAt: number | undefined,
  now: () => number,
  controller: AbortController,
) => {
  if (deadlineAt === undefined) return () => undefined;
  // Node timers overflow above 2^31-1 ms; long waits recheck instead of expiring early.
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      controller.abort();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  schedule();
  return () => clearTimeout(timer);
};
