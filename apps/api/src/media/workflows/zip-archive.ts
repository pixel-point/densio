import { createWriteStream } from "node:fs";

import { ZipArchive } from "archiver";
import { Effect, Schema } from "effect";

export interface ZipArchiveEntry {
  readonly archiveName: string;
  readonly path: string;
}

export class ZipArchiveError extends Schema.TaggedErrorClass<ZipArchiveError>()("ZipArchiveError", {
  message: Schema.String,
}) {}

export const createZipArchive = Effect.fn("MediaWorkflow.createZipArchive")(function* (
  outputPath: string,
  entries: ReadonlyArray<ZipArchiveEntry>,
) {
  yield* Effect.tryPromise({
    catch: () => new ZipArchiveError({ message: "The image archive could not be created." }),
    try: () => streamZipArchive(outputPath, entries),
  });
});

const streamZipArchive = (outputPath: string, entries: ReadonlyArray<ZipArchiveEntry>) =>
  new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outputPath, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 } });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      archive.abort();
      output.destroy();
      reject(error);
    };

    output.once("close", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    output.once("error", fail);
    archive.once("error", fail);
    archive.once("warning", fail);
    archive.pipe(output);
    entries.forEach((entry) => archive.file(entry.path, { name: entry.archiveName }));
    void archive.finalize().catch(fail);
  });
