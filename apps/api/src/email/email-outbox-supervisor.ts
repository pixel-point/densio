import { Clock, Deferred, Effect, Fiber, Ref, type Scope } from "effect";

import type { Database } from "../database/database.ts";
import type { MagicLinkOpener } from "../auth/magic-link-secret.ts";
import {
  deliverNextEmail,
  type EmailOutboxWorkerConfig,
  type EmailSender,
} from "./email-outbox-worker.ts";

interface EmailOutboxSupervisorConfig extends EmailOutboxWorkerConfig {
  readonly pollIntervalMs: number;
}

export interface EmailOutboxSupervisor {
  readonly stop: () => Effect.Effect<void>;
}

export const startEmailOutboxSupervisor = Effect.fn("EmailOutboxSupervisor.start")(function* (
  database: Database,
  sender: EmailSender,
  openMagicLink: MagicLinkOpener,
  config: EmailOutboxSupervisorConfig,
): Effect.fn.Return<EmailOutboxSupervisor, never, Scope.Scope> {
  const stopping = yield* Ref.make(false);
  const stopSignal = yield* Deferred.make<void>();
  const fiber = yield* runLoop(database, sender, openMagicLink, config, stopping, stopSignal).pipe(
    Effect.forkScoped({ startImmediately: true }),
  );
  const stop = Effect.fn("EmailOutboxSupervisor.stop")(function* () {
    yield* Ref.set(stopping, true);
    yield* Deferred.succeed(stopSignal, undefined);
    yield* Fiber.join(fiber);
  });
  return { stop };
});

const runLoop = Effect.fn("EmailOutboxSupervisor.runLoop")(function* (
  database: Database,
  sender: EmailSender,
  openMagicLink: MagicLinkOpener,
  config: EmailOutboxSupervisorConfig,
  stopping: Ref.Ref<boolean>,
  stopSignal: Deferred.Deferred<void>,
) {
  while (!(yield* Ref.get(stopping))) {
    const now = yield* Clock.currentTimeMillis;
    const outcome = yield* deliverNextEmail({ config, database, now, openMagicLink, sender }).pipe(
      Effect.catch(() =>
        Effect.logError("Email outbox iteration failed.").pipe(
          Effect.as({ kind: "idle" as const }),
        ),
      ),
    );
    if (outcome.kind !== "idle") continue;
    yield* Effect.raceFirst(Effect.sleep(config.pollIntervalMs), Deferred.await(stopSignal));
  }
});
