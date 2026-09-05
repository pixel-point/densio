import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { withHlsScratchBudget } from "../src/media/workflows/hls-scratch.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("counts the package and archive together and interrupts work that exceeds the physical scratch budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-hls-budget-"));
  roots.push(directory);
  let interrupted = false;
  const work = Effect.promise(async () => {
    await writeFile(join(directory, "package.m4s"), Buffer.alloc(8192));
    await writeFile(join(directory, "hls.zip"), Buffer.alloc(8192));
  }).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(
      Effect.sync(() => {
        interrupted = true;
      }),
    ),
  );
  await expect(
    Effect.runPromise(withHlsScratchBudget(directory, 12000, work)),
  ).rejects.toMatchObject({
    _tag: "HlsScratchLimitExceeded",
    actualBytes: expect.any(Number),
    limitBytes: 12000,
  });
  expect(interrupted).toBe(true);
}, 10000);

it("checks completed short operations without waiting for the monitor interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-hls-budget-"));
  roots.push(directory);
  await expect(
    Effect.runPromise(
      withHlsScratchBudget(
        directory,
        1,
        Effect.promise(() => writeFile(join(directory, "package.m4s"), "bytes")),
      ),
    ),
  ).rejects.toMatchObject({ _tag: "HlsScratchLimitExceeded" });
});
