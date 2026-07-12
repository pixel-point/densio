import { open } from "node:fs/promises";
import { Readable } from "node:stream";

import { Effect, Schema } from "effect";
import { Hono } from "hono";

import { ArtifactUnavailable, findSignedArtifact } from "../database/artifact-repository.ts";
import type { Database } from "../database/database.ts";
import { createArtifactEtag } from "../storage/artifact.ts";
import { parseSingleRange, type ByteRange } from "../storage/byte-range.ts";
import { StorageOperationError } from "../storage/workspace.ts";
import { beginRequest, runRouteEffect } from "./route-support.ts";

const SafeFilenameSchema = Schema.String.check(Schema.isPattern(/^[^\p{Cc}/\\]+$/u));
const decodeSafeFilename = Schema.decodeUnknownEffect(SafeFilenameSchema);

export interface ArtifactRouteDependencies {
  readonly createCorrelationId: () => string;
  readonly database: Database;
  readonly now: () => number;
}

export const createArtifactRoutes = (dependencies: ArtifactRouteDependencies) => {
  const routes = new Hono();
  routes.get("/v1/artifacts/:artifactId/:token/:filename", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const now = dependencies.now();
      const filename = yield* decodeSafeFilename(context.req.param("filename")).pipe(
        Effect.mapError(() => new ArtifactUnavailable({ reason: "invalid" })),
      );
      const artifact = yield* findSignedArtifact(dependencies.database, {
        artifactId: context.req.param("artifactId"),
        now,
        token: context.req.param("token"),
      });
      if (filename !== artifact.filename) {
        return yield* new ArtifactUnavailable({ reason: "invalid" });
      }
      const etag = createArtifactEtag(artifact.sha256);
      if (etagMatches(context.req.header("if-none-match"), etag)) {
        return {
          cacheControl: artifactCacheControl(artifact.expiresAt, now),
          etag,
          kind: "not-modified" as const,
        };
      }
      const range = yield* parseSingleRange(
        rangeHeader(context.req.header("range"), context.req.header("if-range"), etag),
        artifact.sizeBytes,
      );
      const file = yield* Effect.tryPromise({
        catch: () =>
          new StorageOperationError({
            message: "The artifact could not be opened.",
            operation: "open-artifact",
          }),
        try: () => open(artifact.path, "r"),
      });
      return { artifact, etag, file, kind: "artifact" as const, now, range };
    });
    return runRouteEffect(context, correlationId, program, (result) => {
      if (result.kind === "not-modified") {
        return new Response(null, {
          headers: {
            "cache-control": result.cacheControl,
            etag: result.etag,
            "x-correlation-id": correlationId,
          },
          status: 304,
        });
      }
      const stream = result.file.createReadStream(streamOptions(result.range));
      return new Response(Readable.toWeb(stream), {
        headers: artifactHeaders(result, correlationId),
        status: result.range === undefined ? 200 : 206,
      });
    });
  });
  return routes;
};

const artifactHeaders = (
  result: Readonly<{
    artifact: {
      readonly expiresAt: number;
      readonly filename: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
    };
    etag: string;
    now: number;
    range: ByteRange | undefined;
  }>,
  correlationId: string,
) => ({
  "accept-ranges": "bytes",
  "cache-control": artifactCacheControl(result.artifact.expiresAt, result.now),
  "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.artifact.filename)}`,
  "content-length": String(result.range?.length ?? result.artifact.sizeBytes),
  "content-type": result.artifact.mediaType,
  etag: result.etag,
  ...(result.range === undefined ? {} : { "content-range": result.range.contentRange }),
  "x-correlation-id": correlationId,
});

const artifactCacheControl = (expiresAt: number, now: number) =>
  `private, max-age=${Math.max(0, Math.floor((expiresAt - now) / 1_000))}, immutable`;

const streamOptions = (range: ByteRange | undefined) =>
  range === undefined ? {} : { end: range.end, start: range.start };

const rangeHeader = (range: string | undefined, ifRange: string | undefined, etag: string) =>
  ifRange === undefined || ifRange === etag ? range : undefined;

const etagMatches = (header: string | undefined, etag: string) =>
  header
    ?.split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag || candidate === `W/${etag}`) ??
  false;
