import { Clock, Deferred, Effect, Fiber, Ref, type Scope } from "effect";

import { cleanupExpiredArtifacts } from "../database/artifact-repository.ts";
import type { Database } from "../database/database.ts";
import { cleanupTerminalJobWorkspaces } from "../jobs/terminal-workspace-cleanup.ts";

interface ArtifactCleanupConfig {
  readonly intervalMs: number;
  readonly mediaRoot: string;
}

export interface ArtifactCleanupSupervisor {
  readonly stop: () => Effect.Effect<void>;
}

export const startArtifactCleanupSupervisor = Effect.fn("ArtifactCleanupSupervisor.start")(
  function* (
    database: Database,
    config: ArtifactCleanupConfig,
  ): Effect.fn.Return<ArtifactCleanupSupervisor, never, Scope.Scope> {
    const stopping = yield* Ref.make(false);
    const stopSignal = yield* Deferred.make<void>();
    const fiber = yield* runLoop(database, config, stopping, stopSignal).pipe(
      Effect.forkScoped({ startImmediately: true }),
    );
    const stop = Effect.fn("ArtifactCleanupSupervisor.stop")(function* () {
      yield* Ref.set(stopping, true);
      yield* Deferred.succeed(stopSignal, undefined);
      yield* Fiber.join(fiber);
    });
    return { stop };
  },
);

const runLoop = Effect.fn("ArtifactCleanupSupervisor.runLoop")(function* (
  database: Database,
  config: ArtifactCleanupConfig,
  stopping: Ref.Ref<boolean>,
  stopSignal: Deferred.Deferred<void>,
) {
  while (!(yield* Ref.get(stopping))) {
    const now = yield* Clock.currentTimeMillis;
    yield* cleanupExpiredArtifacts(database, { mediaRoot: config.mediaRoot, now }).pipe(
      Effect.catch(() => Effect.logError("Artifact cleanup iteration failed.")),
    );
    yield* cleanupTerminalJobWorkspaces(database, config.mediaRoot).pipe(
      Effect.catch(() => Effect.logError("Terminal workspace cleanup iteration failed.")),
    );
    yield* Effect.raceFirst(Effect.sleep(config.intervalMs), Deferred.await(stopSignal));
  }
});
