import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { workflowFileOperation } from "./workflow-staging.ts";

export class HlsScratchLimitExceeded extends Schema.TaggedErrorClass<HlsScratchLimitExceeded>()(
  "HlsScratchLimitExceeded",
  { actualBytes: Schema.Number, limitBytes: Schema.Number },
) {}

export const withHlsScratchBudget = <A, E, R>(
  directory: string,
  maximumBytes: number,
  work: Effect.Effect<A, E, R>,
) => {
  const check = Effect.gen(function* () {
    const usage = yield* workflowFileOperation("measure-hls-scratch", () =>
      measureScratch(directory),
    );
    if (usage.bytes > maximumBytes || usage.availableBytes < 64 * 1024 * 1024)
      return yield* new HlsScratchLimitExceeded({
        actualBytes: usage.bytes,
        limitBytes: maximumBytes,
      });
  });
  return check.pipe(
    Effect.andThen(
      Effect.raceFirst(
        work.pipe(Effect.tap(() => check)),
        check.pipe(Effect.andThen(Effect.sleep("2 seconds")), Effect.forever),
      ),
    ),
  );
};

const measureScratch = async (directory: string) => {
  const filesystem = await statfs(directory);
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  if (entries.length > 20010) return { bytes: Number.MAX_SAFE_INTEGER, availableBytes: 0 };
  let bytes = 0;
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    // FFmpeg atomically renames temporary playlists while this snapshot is sampled.
    const metadata = await lstat(join(entry.parentPath, entry.name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (metadata) bytes += Math.max(metadata.size, metadata.blocks * 512);
  }
  return { bytes, availableBytes: filesystem.bavail * filesystem.bsize };
};
