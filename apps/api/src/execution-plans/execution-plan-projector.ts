import {
  ExecutionPlanSnapshotSchema,
  ExecutionPlanStatusSchema,
  SourceInspectionSchema,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import type { Database } from "../database/database.ts";
import type { executionPlans, preparedSources } from "../database/schema.ts";
import {
  ExecutionPlanSourceUnavailable,
  ExecutionPlanStorageError,
} from "./execution-plan-errors.ts";
import { findOwnedReadyPreparedSource } from "./execution-plan-repository.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";

export const projectExecutionPlan = Effect.fn("ExecutionPlanProjector.project")(function* (
  database: Database,
  publicBaseUrl: string,
  row: typeof executionPlans.$inferSelect,
  now: number,
) {
  const snapshot = yield* decodePlanField(ExecutionPlanSnapshotSchema, row.snapshotJson);
  const source = yield* tryPlanStorage("plan-availability", () =>
    findOwnedReadyPreparedSource(database, row.sourceId, row.organizationId, now),
  );
  const availability =
    row.expiresAt <= now ? "expired" : source === undefined ? "source-unavailable" : "available";
  const operation = snapshot.state === "ready" ? "execute" : "resolve";
  return yield* Schema.decodeUnknownEffect(ExecutionPlanStatusSchema)({
    ...snapshot,
    planId: row.id,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    ...(row.supersedesPlanId === null ? {} : { supersedesPlanId: row.supersedesPlanId }),
    availability,
    ...(availability !== "available"
      ? {}
      : {
          [operation]: {
            method: "POST",
            url: new URL(
              `/v1/organizations/${row.organizationId}/execution-plans/${row.id}/${operation}`,
              publicBaseUrl,
            ).toString(),
            expiresAt: new Date(row.expiresAt).toISOString(),
          },
        }),
  }).pipe(
    Effect.mapError((cause) => new ExecutionPlanStorageError({ cause, operation: "project-plan" })),
  );
});

export const decodePlanSource = Effect.fn("ExecutionPlanProjector.source")(function* (
  source: typeof preparedSources.$inferSelect,
) {
  if (source.inputBytes === null || source.inputSha256 === null || source.inspectionJson === null)
    return yield* new ExecutionPlanSourceUnavailable();
  return {
    sourceId: source.id,
    filename: source.sourceFilename,
    declaredBytes: source.declaredBytes,
    verifiedBytes: source.inputBytes,
    sha256: source.inputSha256,
    inspection: yield* decodePlanField(SourceInspectionSchema, source.inspectionJson),
  };
});

export const decodePlanField = <S extends Schema.Top>(schema: S, value: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError((cause) => new ExecutionPlanStorageError({ cause, operation: "decode-plan" })),
  );

export const tryPlanStorage = Effect.fn("ExecutionPlanRepository.evaluate")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      try: evaluate,
      catch: (cause) =>
        cause instanceof OrganizationError || cause instanceof ExecutionPlanSourceUnavailable
          ? cause
          : new ExecutionPlanStorageError({ cause, operation }),
    }),
);
