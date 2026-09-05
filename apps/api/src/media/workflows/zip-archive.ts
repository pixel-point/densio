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
  options: { readonly store?: boolean } = {},
) {
  yield* Effect.callback<void, ZipArchiveError>((resume) => {
    const output = createWriteStream(outputPath, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 9 }, store: options.store ?? false });
    const completion = Promise.withResolvers<void>();
    let failed = false;
    const stop = () => {
      archive.abort();
      output.destroy();
    };
    const fail = () => {
      failed = true;
      stop();
    };

    output.once("close", () => {
      completion.resolve();
      resume(
        failed
          ? Effect.fail(new ZipArchiveError({ message: "The archive could not be created." }))
          : Effect.void,
      );
    });
    output.once("error", fail);
    archive.once("error", fail);
    archive.once("warning", fail);
    archive.pipe(output);
    entries.forEach((entry) => archive.file(entry.path, { name: entry.archiveName }));
    void archive.finalize().catch(fail);
    return Effect.promise(async () => {
      stop();
      await completion.promise;
    });
  });
});
