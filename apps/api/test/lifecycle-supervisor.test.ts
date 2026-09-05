import { checkLifecycleReadiness } from "../src/services/readiness.ts";
import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { startLifecycleSupervisor } from "../src/services/lifecycle-supervisor.ts";

it("recovers a maintenance defect and exposes the loop's latest successful iteration", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        let calls = 0;
        const supervisor = yield* startLifecycleSupervisor(
          () =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1) return yield* Effect.die(new Error("secret provider detail"));
              yield* Deferred.succeed(completed, undefined);
            }),
          1,
          "test-maintenance",
        );
        const finished = yield* Effect.raceFirst(
          Deferred.await(completed).pipe(Effect.as(true)),
          Effect.sleep(100).pipe(Effect.as(false)),
        );
        expect(finished).toBe(true);
        yield* supervisor.stop();
        const status = yield* supervisor.status();
        expect(status).toMatchObject({ name: "test-maintenance", state: "stopped", failures: 1 });
        expect(status.lastSuccessAt).toEqual(expect.any(Number));
      }),
    ),
  );
});

it("independent maintenance supervisors progress while another is blocked", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const blocked = yield* Deferred.make<void>();
        const progress = yield* Deferred.make<void>();
        const source = yield* startLifecycleSupervisor(() => Deferred.await(blocked), 1, "sources");
        const transfer = yield* startLifecycleSupervisor(
          () => Deferred.succeed(progress, undefined).pipe(Effect.asVoid),
          1,
          "transfers",
        );
        yield* Deferred.await(progress);
        const stopping = yield* source.stop().pipe(Effect.forkScoped);
        yield* Deferred.succeed(blocked, undefined);
        yield* Fiber.join(stopping);
        yield* transfer.stop();
      }),
    ),
  );
});

it("readiness observes a stopped critical supervisor", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* startLifecycleSupervisor(() => Effect.void, 1000, "critical");
        yield* supervisor.stop();
        const error = yield* checkLifecycleReadiness([supervisor]).pipe(Effect.flip);
        expect(error.check).toBe("workers");
      }),
    ),
  );
});
