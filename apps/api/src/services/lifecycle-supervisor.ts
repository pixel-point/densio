import { Clock, Deferred, Effect, Exit, Fiber, Ref, type Scope } from "effect";

export interface LifecycleSupervisor {
  readonly stop: () => Effect.Effect<void>;
  readonly status: () => Effect.Effect<LifecycleStatus>;
}

interface LifecycleStatus {
  readonly name: string;
  readonly state: "starting" | "running" | "failed" | "stopped";
  readonly failures: number;
  readonly lastSuccessAt?: number;
}

interface LifecycleMaintainer {
  (input: { readonly now: number }): Effect.Effect<void, unknown>;
}

export const startLifecycleSupervisor = Effect.fn("LifecycleSupervisor.start")(function* (
  maintain: LifecycleMaintainer,
  intervalMs: number,
  name = "lifecycle",
): Effect.fn.Return<LifecycleSupervisor, never, Scope.Scope> {
  const stopping = yield* Ref.make(false);
  const stopSignal = yield* Deferred.make<void>();
  const status = yield* Ref.make<LifecycleStatus>({ name, state: "starting", failures: 0 });
  const fiber = yield* runLoop(maintain, intervalMs, stopping, stopSignal, status).pipe(
    Effect.forkScoped({ startImmediately: true }),
  );
  const stop = Effect.fn("LifecycleSupervisor.stop")(function* () {
    yield* Ref.set(stopping, true);
    yield* Deferred.succeed(stopSignal, undefined);
    yield* Fiber.join(fiber);
    yield* Ref.update(status, (current) => ({ ...current, state: "stopped" as const }));
  });
  return { stop, status: () => Ref.get(status) };
});

const runLoop = Effect.fn("LifecycleSupervisor.runLoop")(function* (
  maintain: LifecycleMaintainer,
  intervalMs: number,
  stopping: Ref.Ref<boolean>,
  stopSignal: Deferred.Deferred<void>,
  status: Ref.Ref<LifecycleStatus>,
) {
  while (!(yield* Ref.get(stopping))) {
    const now = yield* Clock.currentTimeMillis;
    const outcome = yield* Effect.suspend(() => maintain({ now })).pipe(Effect.exit);
    if (Exit.hasInterrupts(outcome)) return yield* Effect.interrupt;
    const failed = Exit.isFailure(outcome);
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* Ref.update(status, (current) => ({
      ...current,
      state: failed ? ("failed" as const) : ("running" as const),
      failures: current.failures + Number(failed),
      ...(failed ? {} : { lastSuccessAt: finishedAt }),
    }));
    if (failed)
      yield* Effect.logError("Lifecycle maintenance iteration failed.", yield* Ref.get(status));
    yield* Effect.raceFirst(Effect.sleep(intervalMs), Deferred.await(stopSignal));
  }
});
