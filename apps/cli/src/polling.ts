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
  readonly poll: () => Promise<Response>;
  readonly runtime: Pick<CliRuntime, "now" | "signal" | "sleep">;
  readonly timeoutError: () => Error;
}

export const pollUntilComplete = async <Response, Value>(
  options: PollingOptions<Response, Value>,
) => {
  const maximumTransientFailures = options.maximumTransientFailures ?? 3;
  let delayMilliseconds = options.initialDelayMilliseconds;
  let transientFailures = 0;
  while (options.deadlineAt === undefined || options.runtime.now() < options.deadlineAt) {
    await sleepAbortably(options.runtime, delayMilliseconds, options.interruptedError);
    if (options.deadlineAt !== undefined && options.runtime.now() >= options.deadlineAt) break;
    const response = await options.poll().catch((cause: unknown) => {
      if (options.runtime.signal?.aborted === true) throw options.interruptedError();
      if (!options.isRetryableFailure(cause) || transientFailures >= maximumTransientFailures) {
        throw cause;
      }
      transientFailures += 1;
      return undefined;
    });
    if (response === undefined) {
      delayMilliseconds = 1_000 * 2 ** (transientFailures - 1);
      continue;
    }
    transientFailures = 0;
    const decision = options.decide(response);
    if (decision.kind === "complete") return decision.value;
    delayMilliseconds = decision.delayMilliseconds;
  }
  throw options.timeoutError();
};

const sleepAbortably = (
  runtime: Pick<CliRuntime, "signal" | "sleep">,
  milliseconds: number,
  interruptedError: () => Error,
) => {
  if (runtime.signal === undefined) return runtime.sleep(milliseconds);
  if (runtime.signal.aborted) return Promise.reject(interruptedError());
  const signal = runtime.signal;
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(interruptedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    void runtime.sleep(milliseconds).then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, reject);
  });
};
