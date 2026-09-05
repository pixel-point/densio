import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import {
  type MediaProcessCommand,
  MediaProcessRunner,
} from "../src/media/process/media-process-runner.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";

const fixtureSource = fileURLToPath(
  new URL("./fixtures/media-workflow-fixture.mjs", import.meta.url),
);

export const temporaryWorkflowRoots: Array<string> = [];

export const makeWorkflowTestContext = async (mode: string) => {
  const root = await mkdtemp(join(tmpdir(), "densio-workflow-"));
  temporaryWorkflowRoots.push(root);
  const executable = join(root, mode);
  await copyFile(fixtureSource, executable);
  await chmod(executable, 0o755);
  const paths = await Effect.runPromise(makeJobStoragePaths(root, "job-workflow"));
  await Effect.runPromise(prepareJobWorkspace(paths));
  await writeFile(paths.inputFile, "source-video");

  return { executable, paths } as const;
};

export const provideWorkflowRunner = <A, E>(
  effect: Effect.Effect<A, E, MediaProcessRunner>,
  observe?: (command: MediaProcessCommand) => void,
) =>
  Effect.gen(function* () {
    const runner = yield* MediaProcessRunner;
    return yield* effect.pipe(
      Effect.provideService(
        MediaProcessRunner,
        MediaProcessRunner.of({
          run: (command) => {
            observe?.(command);
            return runner.run(command);
          },
        }),
      ),
    );
  }).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 3 })));

export const cleanupWorkflowTestRoots = async () => {
  await Promise.all(
    temporaryWorkflowRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
};
