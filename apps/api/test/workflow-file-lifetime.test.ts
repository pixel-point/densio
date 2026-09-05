import { setImmediate } from "node:timers/promises";
import { Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { workflowFileOperation } from "../src/media/workflows/workflow-staging.ts";

it("holds the workflow lifetime until an interrupted native write finishes", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const events: string[] = [];
  const fiber = Effect.runFork(
    workflowFileOperation("delayed-native-write", async () => {
      entered.resolve();
      await finish.promise;
    }).pipe(Effect.ensuring(Effect.sync(() => events.push("released")))),
  );
  await entered.promise;
  const interruption = Effect.runPromise(Fiber.interrupt(fiber));
  await setImmediate();
  const beforeWriteCompletes = [...events];
  finish.resolve();
  await interruption;
  expect(beforeWriteCompletes).toEqual([]);
  expect(events).toEqual(["released"]);
});
