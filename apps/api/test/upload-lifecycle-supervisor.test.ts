import { Effect } from "effect";
import { expect, it } from "vitest";

import { startUploadLifecycleSupervisor } from "../src/jobs/upload-lifecycle-supervisor.ts";

it("maintains uploads immediately and stops without waiting for the next interval", async () => {
  const invocations: Array<number> = [];

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* startUploadLifecycleSupervisor(
          ({ now }) => Effect.sync(() => invocations.push(now)),
          60_000,
        );
        yield* waitUntil(() => invocations.length === 1);
        yield* supervisor.stop();
      }),
    ),
  );

  expect(invocations).toHaveLength(1);
});

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.sleep(5);
    }
    return yield* Effect.die("Timed out waiting for upload maintenance");
  });
