import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Effect, Schema } from "effect";

const JobIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, { expected: "a safe job id" }),
);
const FilenameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/, { expected: "a safe filename" }),
);
const decodeJobId = Schema.decodeUnknownEffect(JobIdSchema);
const decodeFilename = Schema.decodeUnknownEffect(FilenameSchema);
const jobStoragePathsBrand: unique symbol = Symbol("JobStoragePaths");

export class InvalidStoragePath extends Schema.TaggedErrorClass<InvalidStoragePath>()(
  "InvalidStoragePath",
  { message: Schema.String },
) {}

export class StorageOperationError extends Schema.TaggedErrorClass<StorageOperationError>()(
  "StorageOperationError",
  { message: Schema.String, operation: Schema.String },
) {}

export type JobStoragePaths = Readonly<{
  artifactDirectory: string;
  inputFile: string;
  mediaRoot: string;
  stagingDirectory: string;
  workspaceDirectory: string;
  [jobStoragePathsBrand]: true;
}>;

const invalidPath = () =>
  new InvalidStoragePath({ message: "The requested storage path is invalid." });

const resolveContained = Effect.fn("Storage.resolveContained")(function* (
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

const verifyJobStoragePaths = Effect.fn("Storage.verifyJobStoragePaths")(function* (
  paths: JobStoragePaths,
) {
  if (paths[jobStoragePathsBrand] !== true || !Object.isFrozen(paths)) {
    return yield* invalidPath();
  }
});

export const makeJobStoragePaths = Effect.fn("Storage.makeJobStoragePaths")(function* (
  mediaRootInput: string,
  jobIdInput: unknown,
) {
  const jobId = yield* decodeJobId(jobIdInput).pipe(Effect.mapError(invalidPath));
  const mediaRoot = resolve(mediaRootInput);
  const workspaceDirectory = yield* resolveContained(mediaRoot, "work", jobId);
  const artifactDirectory = yield* resolveContained(mediaRoot, "artifacts", jobId);

  const paths = {
    artifactDirectory,
    inputFile: yield* resolveContained(workspaceDirectory, "input", "source-video"),
    mediaRoot,
    stagingDirectory: yield* resolveContained(workspaceDirectory, "staging"),
    workspaceDirectory,
  };
  Object.defineProperty(paths, jobStoragePathsBrand, { value: true });

  return Object.freeze(paths) as JobStoragePaths;
});

const resolveJobFile = Effect.fn("Storage.resolveJobFile")(function* (
  directory: string,
  filenameInput: unknown,
) {
  const filename = yield* decodeFilename(filenameInput).pipe(Effect.mapError(invalidPath));
  return yield* resolveContained(directory, filename);
});

export const resolveStagedFile = Effect.fn("Storage.resolveStagedFile")(function* (
  paths: JobStoragePaths,
  filename: unknown,
) {
  yield* verifyJobStoragePaths(paths);
  return yield* resolveJobFile(paths.stagingDirectory, filename);
});

export const resolveArtifactFile = Effect.fn("Storage.resolveArtifactFile")(function* (
  paths: JobStoragePaths,
  filename: unknown,
) {
  yield* verifyJobStoragePaths(paths);
  return yield* resolveJobFile(paths.artifactDirectory, filename);
});

const storageOperation = (operation: string, run: () => Promise<unknown>) =>
  Effect.tryPromise({
    catch: () => new StorageOperationError({ message: "The storage operation failed.", operation }),
    try: run,
  }).pipe(Effect.asVoid);

export const prepareJobWorkspace = Effect.fn("Storage.prepareJobWorkspace")(function* (
  paths: JobStoragePaths,
  options: { readonly includeArtifactDirectory?: boolean } = {},
) {
  yield* verifyJobStoragePaths(paths);
  const directories = [dirname(paths.inputFile), paths.stagingDirectory];
  const requiredDirectories = options.includeArtifactDirectory
    ? [...directories, paths.artifactDirectory]
    : directories;

  yield* storageOperation("prepare-workspace", () =>
    Promise.all(requiredDirectories.map((directory) => mkdir(directory, { recursive: true }))),
  );
});

export const cleanupJobWorkspace = Effect.fn("Storage.cleanupJobWorkspace")(function* (
  paths: JobStoragePaths,
) {
  yield* verifyJobStoragePaths(paths);
  yield* storageOperation("cleanup-workspace", () =>
    rm(paths.workspaceDirectory, { force: true, recursive: true }),
  );
});
