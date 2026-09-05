import { toPreparedSourceStatus } from "./source-status.ts";
import { assertSourceIngestion, expireSourceIngestion } from "./source-ingestion-state.ts";
import { randomUUID } from "node:crypto";

import { type PreparedSourceCreateResponse } from "@densio/shared";
import { Effect, Result } from "effect";

import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { listOwnedPreparedSources } from "../database/source-query-repository.ts";
import type { Database } from "../database/database.ts";
import {
  claimPreparedSourceUpload,
  completePreparedSourceInspection,
  createPreparedSource,
  expireDuePreparedSources,
  deleteOwnedPreparedSource,
  expireOwnedPreparedSourceIfDue,
  failPreparedSourceInspection,
  findOwnedPreparedSource,
  findPreparedSourceByIdempotencyKey,
  listRecoverablePreparedSources,
  markPreparedSourceInspecting,
} from "../database/prepared-source-repository.ts";
import { preparedSources } from "../database/schema.ts";
import { MediaInspectionError } from "../media/inspection/media-inspection-error.ts";
import type { MediaInspector } from "../media/inspection/media-inspector.ts";
import { normalizeSourceInspection } from "./source-inspection.ts";
import { withSourceWriteActivity } from "./source-write-activity.ts";
import { cleanupPreparedSource, cleanupPreparedSources } from "./source-cleanup.ts";
import {
  publishStoredUpload,
  removeStoredUpload,
  storeUpload,
  verifyStoredUpload,
} from "../storage/upload.ts";
import {
  makeSourceStoragePaths,
  prepareSourceWorkspace,
  resolveSourceStagedFile,
} from "../storage/source-workspace.ts";
import {
  SourceIdempotencyConflict,
  SourceNotFound,
  SourceRepositoryError,
  SourceStateConflict,
  SourceUploadExpired,
  SourceUploadLimitExceeded,
} from "./source-errors.ts";

export {
  SourceIdempotencyConflict,
  SourceNotFound,
  SourceRepositoryError,
  SourceStateConflict,
  SourceUploadExpired,
  SourceUploadLimitExceeded,
} from "./source-errors.ts";

const MAINTENANCE_BATCH_SIZE = 50;
type PreparedSourceRow = typeof preparedSources.$inferSelect;

interface PreparedSourceServiceConfig {
  readonly now: () => number;
  readonly inspector: Pick<MediaInspector["Service"], "inspect">;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
  readonly sourceTtlMs: number;
  readonly uploadTtlMs: number;
}

interface CreatePreparedSourceInput extends OrganizationActor {
  readonly bytes: number;
  readonly correlationId: string;
  readonly filename: string;
  readonly idempotencyKey?: string;
  readonly maxUploadBytes: number;
  readonly now: number;
  readonly organizationId: string;
}

interface OwnedSourceInput extends OrganizationActor {
  readonly sourceId: string;
  readonly organizationId: string;
}

interface UploadPreparedSourceInput extends OwnedSourceInput {
  readonly body: ReadableStream<Uint8Array>;
  readonly storageObjectId?: string;
  readonly correlationId: string;
  readonly now: number;
}

export const makePreparedSourceService = (
  database: Database,
  config: PreparedSourceServiceConfig,
) => {
  const create = (input: CreatePreparedSourceInput) =>
    createPreparedSourceResource(database, config, input);

  const status = Effect.fn("PreparedSourceService.status")(function* (
    input: OwnedSourceInput & { readonly correlationId: string; readonly now: number },
  ) {
    const source = yield* findOwnedSource(database, input);
    const current = isExpired(source, input.now)
      ? yield* expireIfDueAndCleanup(database, config.mediaRoot, source, input.now)
      : source;
    return yield* toPreparedSourceStatus(database, current, config, input.correlationId);
  });

  const upload = Effect.fn("PreparedSourceService.upload")(function* (
    input: UploadPreparedSourceInput,
  ) {
    yield* assertSourceIngestion(database, input.sourceId, input.storageObjectId);
    const source = yield* findOwnedSource(database, input);
    const available = isExpired(source, input.now)
      ? yield* expireIfDueAndCleanup(database, config.mediaRoot, source, input.now)
      : source;
    if (available.state === "expired") return yield* new SourceUploadExpired();
    const current = yield* withSourceWriteActivity(
      database,
      available,
      prepareUpload(database, config, available, input),
    );
    yield* cleanupPreparedSource(database, config.mediaRoot, current.id, input.now);
    return yield* toPreparedSourceStatus(database, current, config, input.correlationId);
  });

  const deleteSource = Effect.fn("PreparedSourceService.delete")(function* (
    input: OwnedSourceInput & { readonly now: number },
  ) {
    const source = yield* findOwnedSource(database, input);
    yield* trySourceRepository("expire-upload-session", () =>
      expireSourceIngestion(database, source.id, input.now),
    );
    const expired = yield* deleteAndCleanup(database, config.mediaRoot, source, input, input.now);
    return {
      organizationId: source.organizationId,
      deletedAt: new Date(expired.deletedAt ?? input.now).toISOString(),
      sourceId: expired.id,
      state: "deleted" as const,
    };
  });

  const maintain = Effect.fn("PreparedSourceService.maintain")(function* (input: {
    readonly now: number;
  }) {
    yield* trySourceRepository("expire-due", () =>
      expireDuePreparedSources(database, { limit: MAINTENANCE_BATCH_SIZE, now: input.now }),
    );
    yield* runMaintenancePages(
      ({ afterId, limit }) =>
        trySourceRepository("list-recoverable", () =>
          listRecoverablePreparedSources(database, limit, afterId),
        ),
      (source) =>
        withSourceWriteActivity(
          database,
          source,
          maintainSource(database, config, source, input.now),
        ),
      "Source inspection recovery",
    );
    yield* cleanupPreparedSources(database, config.mediaRoot, input.now);
  });

  const list = Effect.fn("PreparedSourceService.list")(function* (
    input: Parameters<typeof listOwnedPreparedSources>[1] &
      OrganizationActor & { readonly correlationId: string },
  ) {
    const page = yield* listOwnedPreparedSources(database, input);
    return {
      organizationId: input.organizationId,
      sources: yield* Effect.forEach(page.sources, (source) =>
        toPreparedSourceStatus(database, source, config, input.correlationId),
      ),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
  return {
    create,
    delete: deleteSource,
    maintain,
    status,
    list,
    upload: (input: Omit<UploadPreparedSourceInput, "storageObjectId">) => upload(input),
    ingestObject: (input: UploadPreparedSourceInput & { readonly storageObjectId: string }) =>
      upload(input),
  };
};

const createPreparedSourceResource = Effect.fn("PreparedSourceService.create")(function* (
  database: Database,
  config: PreparedSourceServiceConfig,
  input: CreatePreparedSourceInput,
) {
  yield* organizationStorage("authorize-source-creation", () =>
    authorizeOrganization(database.db, input, "media-write"),
  );
  const existing =
    input.idempotencyKey === undefined
      ? undefined
      : yield* trySourceRepository("find-replay", () =>
          findPreparedSourceByIdempotencyKey(
            database,
            input.organizationId,
            input.idempotencyKey ?? "",
          ),
        );
  if (existing === undefined && input.bytes > input.maxUploadBytes) {
    return yield* new SourceUploadLimitExceeded({ limitBytes: input.maxUploadBytes });
  }
  const creation =
    existing === undefined
      ? yield* trySourceRepository("create", () =>
          createPreparedSource(
            database,
            {
              createdByUserId: input.userId,
              createdAt: input.now,
              declaredBytes: input.bytes,
              requestDigest: sourceRequestDigest(input),
              expiresAt: input.now + config.sourceTtlMs,
              id: randomUUID(),
              ...(input.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: input.idempotencyKey }),
              maxUploadBytes: input.maxUploadBytes,
              sourceFilename: input.filename,
              state: "awaiting-upload",
              updatedAt: input.now,
              uploadExpiresAt: Math.min(
                input.now + config.uploadTtlMs,
                input.now + config.sourceTtlMs,
              ),
              organizationId: input.organizationId,
            },
            input,
          ),
        )
      : { created: false, source: existing };
  if (!creation.created) {
    if (creation.source.requestDigest !== sourceRequestDigest(input)) {
      return yield* new SourceIdempotencyConflict();
    }
  }
  const current =
    !creation.created && isExpired(creation.source, input.now)
      ? yield* expireIfDueAndCleanup(database, config.mediaRoot, creation.source, input.now)
      : creation.source;
  return {
    organizationId: current.organizationId,
    replayed: !creation.created,
    source: yield* toPreparedSourceStatus(database, current, config, input.correlationId),
  } satisfies PreparedSourceCreateResponse;
});

const prepareUpload = Effect.fn("PreparedSourceService.prepareUpload")(function* (
  database: Database,
  config: PreparedSourceServiceConfig,
  source: PreparedSourceRow,
  input: UploadPreparedSourceInput,
) {
  if (source.state === "inspecting")
    return yield* inspectPreparedSource(database, config, source, input.now);
  if (source.state !== "awaiting-upload" && source.state !== "finalizing") {
    return yield* new SourceStateConflict({ state: source.state });
  }
  const recovered =
    source.state === "finalizing"
      ? yield* recoverFinalizingUpload(database, config.mediaRoot, source, input.now)
      : source;
  if (recovered.state === "inspecting") {
    return yield* inspectPreparedSource(database, config, recovered, input.now);
  }
  if (recovered.state !== "awaiting-upload") {
    return yield* new SourceStateConflict({ state: recovered.state });
  }
  return yield* storePendingUpload(database, config, recovered, input);
});

const storePendingUpload = Effect.fn("PreparedSourceService.storeUpload")(function* (
  database: Database,
  config: PreparedSourceServiceConfig,
  source: PreparedSourceRow,
  input: UploadPreparedSourceInput,
) {
  const paths = yield* makeSourceStoragePaths(config.mediaRoot, source.id);
  yield* prepareSourceWorkspace(paths);
  const stagingFile = `upload-${randomUUID()}`;
  const stagingPath = yield* resolveSourceStagedFile(paths, stagingFile);
  const stored = yield* storeUpload({
    body: input.body,
    declaredBytes: source.declaredBytes,
    destination: stagingPath,
    maxBytes: source.maxUploadBytes,
  });
  const claimed = yield* trySourceRepository("claim-upload", () =>
    claimPreparedSourceUpload(database, { ...input, ...stored, stagingFile, now: config.now() }),
  ).pipe(Effect.tapError(() => removeStoredUpload(stagingPath)));
  if (claimed === undefined) {
    yield* removeStoredUpload(stagingPath);
    const current = yield* findOwnedSource(database, input);
    return yield* new SourceStateConflict({ state: current.state });
  }
  const inspecting = yield* recoverFinalizingUpload(database, config.mediaRoot, claimed, input.now);
  if (inspecting.state !== "inspecting") {
    return yield* new SourceStateConflict({ state: inspecting.state });
  }
  return yield* inspectPreparedSource(database, config, inspecting, input.now);
});

const recoverFinalizingUpload = Effect.fn("PreparedSourceService.recoverUpload")(function* (
  database: Database,
  mediaRoot: string,
  source: PreparedSourceRow,
  now: number,
) {
  const paths = yield* makeSourceStoragePaths(mediaRoot, source.id);
  const current = yield* refetchSource(database, source);
  if (current.state !== "finalizing") return current;
  if (current.inputBytes === null || current.inputSha256 === null) {
    const inspecting = yield* markInspectingOrRefetch(database, current, now);
    return yield* failInspection(database, mediaRoot, inspecting, now, "missing-input-facts");
  }
  const expected = { bytes: current.inputBytes, sha256: current.inputSha256 };
  const stagingPath =
    current.uploadStagingFile === null
      ? undefined
      : yield* resolveSourceStagedFile(paths, current.uploadStagingFile);
  if (!(yield* verifyStoredUpload(paths.inputFile, expected))) {
    const staged = stagingPath !== undefined && (yield* verifyStoredUpload(stagingPath, expected));
    if (staged && stagingPath !== undefined) {
      // Exclusive publication never unlinks a concurrent recovery's verified winner.
      const publication = yield* publishStoredUpload(stagingPath, paths.inputFile).pipe(
        Effect.result,
      );
      if (
        Result.isFailure(publication) &&
        !(yield* verifyStoredUpload(paths.inputFile, expected))
      ) {
        const latest = yield* refetchSource(database, current);
        if (latest.state !== "finalizing") return latest;
        return yield* publication.failure;
      }
    }
    if (!(yield* verifyStoredUpload(paths.inputFile, expected))) {
      const inspecting = yield* markInspectingOrRefetch(database, current, now);
      return yield* failInspection(database, mediaRoot, inspecting, now, "invalid-input");
    }
  }
  const inspecting = yield* markInspectingOrRefetch(database, current, now);
  if (stagingPath !== undefined) yield* removeStoredUpload(stagingPath);
  return inspecting;
});

const markInspectingOrRefetch = Effect.fn("PreparedSourceService.markInspecting")(function* (
  database: Database,
  source: PreparedSourceRow,
  now: number,
) {
  const inspecting = yield* trySourceRepository("mark-inspecting", () =>
    markPreparedSourceInspecting(database, source.id, now),
  );
  return inspecting ?? (yield* refetchSource(database, source));
});

const inspectPreparedSource = Effect.fn("PreparedSourceService.inspect")(function* (
  database: Database,
  config: PreparedSourceServiceConfig,
  source: PreparedSourceRow,
  now: number,
) {
  if (source.inputBytes === null || source.inputSha256 === null) {
    return yield* failInspection(database, config.mediaRoot, source, now, "missing-input-facts");
  }
  const paths = yield* makeSourceStoragePaths(config.mediaRoot, source.id);
  const valid = yield* verifyStoredUpload(paths.inputFile, {
    bytes: source.inputBytes,
    sha256: source.inputSha256,
  });
  if (!valid)
    return yield* failInspection(database, config.mediaRoot, source, now, "invalid-input");

  const result = yield* config.inspector
    .inspect(paths.inputFile)
    .pipe(Effect.flatMap(normalizeSourceInspection), Effect.result);
  if (Result.isFailure(result)) {
    const reason =
      result.failure instanceof MediaInspectionError
        ? result.failure.reason
        : result.failure instanceof SourceRepositoryError
          ? "invalid-probe-output"
          : "process-failed";
    return yield* failInspection(database, config.mediaRoot, source, now, reason);
  }
  const ready = yield* trySourceRepository("complete-inspection", () =>
    completePreparedSourceInspection(database, {
      inspectionJson: JSON.stringify(result.success),
      now,
      sourceId: source.id,
    }),
  );
  return ready ?? (yield* refetchSource(database, source));
});

const failInspection = Effect.fn("PreparedSourceService.failInspection")(function* (
  database: Database,
  mediaRoot: string,
  source: PreparedSourceRow,
  now: number,
  reason: string,
) {
  const failed = yield* trySourceRepository("fail-inspection", () =>
    failPreparedSourceInspection(database, {
      errorCode: "SOURCE_INSPECTION_FAILED",
      errorJson: JSON.stringify({ reason }),
      now,
      sourceId: source.id,
    }),
  );
  const current = failed ?? (yield* refetchSource(database, source));
  if (current.state === "failed") yield* cleanupPreparedSource(database, mediaRoot, source.id, now);
  return current;
});

const maintainSource = Effect.fn("PreparedSourceService.maintainSource")(function* (
  database: Database,
  config: PreparedSourceServiceConfig,
  source: PreparedSourceRow,
  now: number,
) {
  const current =
    source.state === "finalizing"
      ? yield* recoverFinalizingUpload(database, config.mediaRoot, source, now)
      : source;
  if (current.state === "inspecting") {
    yield* inspectPreparedSource(database, config, current, now);
  }
});

const findOwnedSource = Effect.fn("PreparedSourceService.findOwned")(function* (
  database: Database,
  input: OwnedSourceInput,
) {
  yield* organizationStorage("authorize-source", () =>
    authorizeOrganization(database.db, input, "media-read"),
  );
  const source = yield* trySourceRepository("find-owned", () =>
    findOwnedPreparedSource(database, input),
  );
  if (source === undefined) return yield* new SourceNotFound();
  return source;
});

const refetchSource = Effect.fn("PreparedSourceService.refetch")(function* (
  database: Database,
  source: PreparedSourceRow,
) {
  const current = yield* trySourceRepository("refetch", () =>
    findOwnedPreparedSource(database, {
      sourceId: source.id,
      organizationId: source.organizationId,
    }),
  );
  if (current === undefined) return yield* new SourceNotFound();
  return current;
});

const deleteAndCleanup = Effect.fn("PreparedSourceService.expire")(function* (
  database: Database,
  mediaRoot: string,
  source: PreparedSourceRow,
  actor: OrganizationActor,
  now: number,
) {
  const expired = yield* trySourceRepository("expire", () =>
    deleteOwnedPreparedSource(database, source.id, actor, now),
  );
  if (expired === undefined) return yield* new SourceNotFound();
  yield* cleanupPreparedSource(database, mediaRoot, source.id, now);
  return expired;
});

const expireIfDueAndCleanup = Effect.fn("PreparedSourceService.expireIfDue")(function* (
  database: Database,
  mediaRoot: string,
  source: PreparedSourceRow,
  now: number,
) {
  const expired = yield* trySourceRepository("expire-if-due", () =>
    expireOwnedPreparedSourceIfDue(database, source.id, source.organizationId, now),
  );
  if (expired === undefined) return yield* refetchSource(database, source);
  yield* cleanupPreparedSource(database, mediaRoot, source.id, now);
  return expired;
});

const isExpired = (source: PreparedSourceRow, now: number) =>
  source.state !== "deleted" &&
  source.state !== "expired" &&
  (now >= source.expiresAt ||
    (source.state === "awaiting-upload" && now >= source.uploadExpiresAt));

const sourceRequestDigest = (input: CreatePreparedSourceInput) =>
  canonicalDigest({
    organizationId: input.organizationId,
    operation: "sources.create",
    request: { bytes: input.bytes, filename: input.filename },
  });

const trySourceRepository = Effect.fn("PreparedSourceRepository.evaluate")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) =>
        cause instanceof OrganizationError
          ? cause
          : new SourceRepositoryError({ cause, operation }),
      try: evaluate,
    }),
);
