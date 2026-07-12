import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";

export class ReadinessError extends Schema.TaggedErrorClass<ReadinessError>()("ReadinessError", {
  cause: Schema.Defect(),
  check: Schema.Literals(["database", "storage"]),
}) {}

export const checkReadiness = Effect.fn("Readiness.check")(function* (
  database: Database,
  mediaRoot: string,
  versions: { readonly ffmpegVersion: string; readonly ffprobeVersion: string },
) {
  yield* Effect.try({
    catch: (cause) => new ReadinessError({ cause, check: "database" }),
    try: () => database.sqlite.prepare("select 1 as ready").get(),
  });
  const probePath = join(mediaRoot, `.readiness-${randomUUID()}`);
  yield* Effect.tryPromise({
    catch: (cause) => new ReadinessError({ cause, check: "storage" }),
    try: async () => {
      await mkdir(mediaRoot, { recursive: true });
      await writeFile(probePath, "ready", { flag: "wx" });
      await rm(probePath);
    },
  });
  return { ...versions, status: "ready" as const };
});
