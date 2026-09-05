import { realpath, unlink, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Result } from "effect";
import { StorageOperationError } from "./workspace.ts";

export const deleteContainedArtifactFile = Effect.fn("ArtifactDeletion.remove")(function* (
  mediaRoot: string,
  path: string,
  directory = false,
) {
  if (!inside(resolve(mediaRoot), resolve(path))) return yield* deletionError("unsafe-path");
  const deleted = yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      const [root, parent] = await Promise.all([realpath(mediaRoot), realpath(dirname(path))]);
      if (parent !== root && !inside(root, parent)) throw deletionError("unsafe-path");
      if (directory) await rm(path, { recursive: true, force: true });
      if (!directory) await unlink(path);
    },
  }).pipe(Effect.result);
  if (Result.isSuccess(deleted)) return;
  const cause = deleted.failure;
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
  return yield* deletionError(
    cause instanceof StorageOperationError ? cause.operation : "delete-artifact",
  );
});

const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const deletionError = (operation: string) =>
  new StorageOperationError({ operation, message: "The artifact could not be safely deleted." });
