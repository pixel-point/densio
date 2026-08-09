import { Clock, Deferred, Effect, Fiber, Ref, type Scope } from "effect";

interface UploadLifecycleSupervisor {
  readonly stop: () => Effect.Effect<void>;
}

interface UploadMaintainer {
  (input: { readonly now: number }): Effect.Effect<void, unknown>;
}

export const startUploadLifecycleSupervisor = Effect.fn("UploadLifecycleSupervisor.start")(
  function* (
    maintain: UploadMaintainer,
    intervalMs: number,
  ): Effect.fn.Return<UploadLifecycleSupervisor, never, Scope.Scope> {
    const stopping = yield* Ref.make(false);
    const stopSignal = yield* Deferred.make<void>();
    const fiber = yield* runLoop(maintain, intervalMs, stopping, stopSignal).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    const stop = Effect.fn("UploadLifecycleSupervisor.stop")(function* () {
      yield* Ref.set(stopping, true);
      yield* Deferred.succeed(stopSignal, undefined);
      yield* Fiber.join(fiber);
    });
    return { stop };
  },
);

const runLoop = Effect.fn("UploadLifecycleSupervisor.runLoop")(function* (
  maintain: UploadMaintainer,
  intervalMs: number,
  stopping: Ref.Ref<boolean>,
  stopSignal: Deferred.Deferred<void>,
) {
  while (!(yield* Ref.get(stopping))) {
    const now = yield* Clock.currentTimeMillis;
    yield* maintain({ now }).pipe(
      Effect.catch(() => Effect.logError("Upload lifecycle maintenance iteration failed.")),
    );
    yield* Effect.raceFirst(Effect.sleep(intervalMs), Deferred.await(stopSignal));
  }
});
