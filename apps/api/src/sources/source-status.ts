import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { SourceInspectionSchema, type PreparedSourceStatus } from "@densio/shared";
import type { Database } from "../database/database.ts";
import { preparedSources } from "../database/schema.ts";
import { sourceObjectUploads } from "../database/video-storage-schema.ts";
import { makeProblem, toProblemDetails } from "../errors/problem-details.ts";
import { SourceRepositoryError } from "./source-errors.ts";
type PreparedSourceRow = typeof preparedSources.$inferSelect;

export const toPreparedSourceStatus = Effect.fn("PreparedSourceService.toStatus")(function* (
  database: Database,
  source: PreparedSourceRow,
  config: { readonly publicBaseUrl: string },
  correlationId: string,
) {
  const base = {
    organizationId: source.organizationId,
    createdByUserId: source.createdByUserId,
    createdAt: new Date(source.createdAt).toISOString(),
    declaredBytes: source.declaredBytes,
    expiresAt: new Date(source.expiresAt).toISOString(),
    filename: source.sourceFilename,
    sourceId: source.id,
    updatedAt: new Date(source.updatedAt).toISOString(),
  };
  if (source.state === "awaiting-upload") {
    const stored = database.db
      .select()
      .from(sourceObjectUploads)
      .where(eq(sourceObjectUploads.sourceId, source.id))
      .get();
    if (stored)
      return {
        ...base,
        state: "awaiting-upload" as const,
        upload: {
          method: "POST" as const,
          transport: "s3-multipart" as const,
          expiresAt: new Date(stored.expiresAt).toISOString(),
          url: new URL(
            `/v1/organizations/${source.organizationId}/sources/${source.id}/storage-upload`,
            config.publicBaseUrl,
          ).toString(),
        },
      };
    return {
      ...base,
      state: "awaiting-upload" as const,
      upload: {
        expiresAt: new Date(source.uploadExpiresAt).toISOString(),
        method: "PUT" as const,
        url: new URL(
          `/v1/organizations/${source.organizationId}/sources/${source.id}/upload`,
          config.publicBaseUrl,
        ).toString(),
      },
    } satisfies PreparedSourceStatus;
  }
  if (source.state === "inspecting" || source.state === "finalizing") {
    const verified = yield* requiredVerifiedFields(source);
    return { ...base, ...verified, state: source.state } satisfies PreparedSourceStatus;
  }
  if (source.state === "ready") {
    const verified = yield* requiredVerifiedFields(source);
    return {
      ...base,
      ...verified,
      inspection: yield* decodeInspection(source.inspectionJson),
      state: "ready" as const,
    } satisfies PreparedSourceStatus;
  }
  if (source.state === "failed") {
    const verified = optionalVerifiedFields(source);
    return {
      ...base,
      ...verified,
      problem: failedInspectionProblem(correlationId),
      state: "failed" as const,
    } satisfies PreparedSourceStatus;
  }
  const verified = optionalVerifiedFields(source);
  return { ...base, ...verified, state: source.state } satisfies PreparedSourceStatus;
});

const requiredVerifiedFields = (source: PreparedSourceRow) => {
  if (source.inputBytes === null || source.inputSha256 === null) {
    return Effect.fail(
      new SourceRepositoryError({ cause: "missing-input-facts", operation: "build-status" }),
    );
  }
  return Effect.succeed({ sha256: source.inputSha256, verifiedBytes: source.inputBytes });
};

const optionalVerifiedFields = (source: PreparedSourceRow) => {
  if (source.inputBytes !== null && source.inputSha256 !== null) {
    return { sha256: source.inputSha256, verifiedBytes: source.inputBytes };
  }
  return {};
};

const decodeInspection = (value: string | null) => {
  if (value === null) {
    return Effect.fail(
      new SourceRepositoryError({ cause: "missing-inspection", operation: "decode-inspection" }),
    );
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(SourceInspectionSchema))(value).pipe(
    Effect.mapError(
      (cause) => new SourceRepositoryError({ cause, operation: "decode-inspection" }),
    ),
  );
};

const failedInspectionProblem = (correlationId: string) =>
  toProblemDetails(
    makeProblem({
      code: "SOURCE_INSPECTION_FAILED",
      detail: "The prepared upload does not contain supported, inspectable video media.",
      retryable: false,
      status: 422,
      suggestedAction: "Delete this source and upload a supported video file.",
      title: "Source inspection failed",
    }),
    correlationId,
  );
