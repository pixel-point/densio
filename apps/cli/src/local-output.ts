import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { Predicate } from "effect";
import {
  artifactDestinationExistsError,
  artifactOutputUnsafeError,
  networkError,
} from "./cli-errors.ts";

export interface StagedFile {
  readonly temporaryPath: string;
  readonly targetPath: string;
}

interface PublishedFile extends StagedFile {
  readonly backupPath?: string;
}

export const preflightOutput = async (
  outputDirectory: string,
  filenames: ReadonlyArray<string>,
  force: boolean,
) => {
  await ensureNoSymlinkComponents(outputDirectory);
  await mkdir(outputDirectory, { recursive: true }).catch(() =>
    Promise.reject(networkError("The materialization output directory could not be created.")),
  );
  await ensureNoSymlinkComponents(outputDirectory);
  for (const filename of filenames) {
    const target = await pathStatus(join(outputDirectory, filename));
    if (target?.isSymbolicLink() === true || (target !== undefined && !target.isFile())) {
      throw artifactOutputUnsafeError(
        "Materialization targets must be regular files, never links.",
      );
    }
    if (target !== undefined && !force) throw artifactDestinationExistsError();
  }
};

const ensureNoSymlinkComponents = async (path: string) => {
  const root = parse(path).root;
  const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const status = await pathStatus(current);
    if (status?.isSymbolicLink() === true) {
      throw artifactOutputUnsafeError("The materialization output path contains a symbolic link.");
    }
    if (status !== undefined && !status.isDirectory()) {
      throw artifactOutputUnsafeError(
        "The materialization output path contains a non-directory component.",
      );
    }
  }
};

export const stageTextFile = async (targetPath: string, content: string) => {
  const temporaryPath = join(dirname(targetPath), `.densio-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 }).catch(() =>
    Promise.reject(networkError("A generated materialization file could not be staged.")),
  );
  return { targetPath, temporaryPath };
};

export const publishOutputBundle = async (files: ReadonlyArray<StagedFile>, force: boolean) => {
  const published: Array<PublishedFile> = [];
  try {
    for (const file of files) {
      const target = await pathStatus(file.targetPath);
      if (target?.isSymbolicLink() === true || (target !== undefined && !target.isFile())) {
        throw artifactOutputUnsafeError("A materialization target changed after preflight.");
      }
      const backupPath =
        force && target !== undefined ? `${file.targetPath}.densio-${randomUUID()}.bak` : undefined;
      if (backupPath !== undefined) await rename(file.targetPath, backupPath);
      await publishOne(file, force).catch(async (cause: unknown) => {
        if (backupPath !== undefined) {
          await restoreBackup(backupPath, file.targetPath).catch(() => undefined);
        }
        throw cause;
      });
      published.push({ ...file, ...(backupPath === undefined ? {} : { backupPath }) });
    }
  } catch (cause) {
    await rollbackPublished(published);
    throw cause;
  }
  await Promise.all(
    published.map(({ backupPath }) =>
      backupPath === undefined ? undefined : rm(backupPath, { force: true }),
    ),
  );
};

const publishOne = async (file: StagedFile, force: boolean) => {
  if (force) {
    await rename(file.temporaryPath, file.targetPath);
    return;
  }
  await link(file.temporaryPath, file.targetPath).catch((cause: unknown) => {
    if (Predicate.hasProperty(cause, "code") && cause.code === "EEXIST") {
      throw artifactDestinationExistsError();
    }
    throw networkError("A verified materialization file could not be published.");
  });
  await rm(file.temporaryPath, { force: true });
};

const rollbackPublished = async (published: ReadonlyArray<PublishedFile>) => {
  for (const file of published.toReversed()) {
    await rm(file.targetPath, { force: true }).catch(() => undefined);
    if (file.backupPath !== undefined) {
      await restoreBackup(file.backupPath, file.targetPath).catch(() => undefined);
    }
  }
};

const restoreBackup = (backupPath: string, targetPath: string) => rename(backupPath, targetPath);

export const cleanupTemporaryFiles = (files: ReadonlyArray<StagedFile>) =>
  Promise.all(files.map(({ temporaryPath }) => rm(temporaryPath, { force: true }))).then(
    () => undefined,
  );

const pathStatus = (path: string) =>
  lstat(path).catch((cause: unknown) => {
    if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") return undefined;
    throw networkError("The materialization output path could not be inspected.");
  });
export const publishVerifiedArtifact = async (
  temporaryPath: string,
  outputPath: string,
  force: boolean,
) => {
  if (force) {
    await rename(temporaryPath, outputPath).catch(async () => {
      await rm(temporaryPath, { force: true });
      throw networkError("The verified artifact could not replace the local output.");
    });
    return;
  }
  await link(temporaryPath, outputPath).catch(async (cause: unknown) => {
    await rm(temporaryPath, { force: true });
    if (Predicate.hasProperty(cause, "code") && cause.code === "EEXIST") {
      throw artifactDestinationExistsError();
    }
    throw networkError("The verified artifact could not be published locally.");
  });
  await rm(temporaryPath, { force: true }).catch(() =>
    Promise.reject(networkError("The published artifact temporary file could not be removed.")),
  );
};
