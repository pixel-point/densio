import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Effect, Schema } from "effect";

const SourceIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, { expected: "a safe source id" }),
);
const FilenameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/, { expected: "a safe filename" }),
);
const decodeSourceId = Schema.decodeUnknownEffect(SourceIdSchema);
const decodeFilename = Schema.decodeUnknownEffect(FilenameSchema);
const sourceStoragePathsBrand: unique symbol = Symbol("SourceStoragePaths");

export class InvalidStoragePath extends Schema.TaggedErrorClass<InvalidStoragePath>()(
  "InvalidStoragePath",
  { message: Schema.String },
) {}

export class SourceStorageOperationError extends Schema.TaggedErrorClass<SourceStorageOperationError>()(
  "SourceStorageOperationError",
  { message: Schema.String, operation: Schema.String },
) {}

export type SourceStoragePaths = Readonly<{
  inputFile: string;
  mediaRoot: string;
  stagingDirectory: string;
  workspaceDirectory: string;
  [sourceStoragePathsBrand]: true;
}>;

const invalidPath = () =>
  new InvalidStoragePath({ message: "The requested source storage path is invalid." });

const resolveContained = Effect.fn("SourceStorage.resolveContained")(function* (
  root: string,
  ...segments: ReadonlyArray<string>
) {
  const target = resolve(root, ...segments);
  const pathFromRoot = relative(resolve(root), target);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    return yield* invalidPath();
  }
  return target;
});

const verifySourceStoragePaths = Effect.fn("SourceStorage.verifyPaths")(function* (
  paths: SourceStoragePaths,
) {
  if (paths[sourceStoragePathsBrand] !== true || !Object.isFrozen(paths)) {
    return yield* invalidPath();
  }
});

export const makeSourceStoragePaths = Effect.fn("SourceStorage.makePaths")(function* (
  mediaRootInput: string,
  sourceIdInput: unknown,
) {
  const sourceId = yield* decodeSourceId(sourceIdInput).pipe(Effect.mapError(invalidPath));
  const mediaRoot = resolve(mediaRootInput);
  const workspaceDirectory = yield* resolveContained(mediaRoot, "sources", sourceId);
  const paths = {
    inputFile: yield* resolveContained(workspaceDirectory, "input", "source-video"),
    mediaRoot,
    stagingDirectory: yield* resolveContained(workspaceDirectory, "staging"),
    workspaceDirectory,
  };
  Object.defineProperty(paths, sourceStoragePathsBrand, { value: true });
  return Object.freeze(paths) as SourceStoragePaths;
});

export const resolveSourceStagedFile = Effect.fn("SourceStorage.resolveStagedFile")(function* (
  paths: SourceStoragePaths,
  filenameInput: unknown,
) {
  yield* verifySourceStoragePaths(paths);
  const filename = yield* decodeFilename(filenameInput).pipe(Effect.mapError(invalidPath));
  return yield* resolveContained(paths.stagingDirectory, filename);
});

const storageOperation = (operation: string, run: () => Promise<unknown>) =>
  Effect.tryPromise({
    catch: () =>
      new SourceStorageOperationError({
        message: "The prepared source storage operation failed.",
        operation,
      }),
    try: run,
  }).pipe(Effect.asVoid, Effect.uninterruptible);

export const prepareSourceWorkspace = Effect.fn("SourceStorage.prepareWorkspace")(function* (
  paths: SourceStoragePaths,
) {
  yield* verifySourceStoragePaths(paths);
  yield* storageOperation("prepare-source-workspace", () =>
    Promise.all([
      mkdir(dirname(paths.inputFile), { recursive: true }),
      mkdir(paths.stagingDirectory, { recursive: true }),
    ]),
  );
});

export const cleanupSourceWorkspace = Effect.fn("SourceStorage.cleanupWorkspace")(function* (
  paths: SourceStoragePaths,
) {
  yield* verifySourceStoragePaths(paths);
  yield* storageOperation("cleanup-source-workspace", () =>
    rm(paths.workspaceDirectory, { force: true, recursive: true }),
  );
});
