import {
  StorageTransferSchema,
  VideoStateSchema,
  type StorageDestination,
  type StorageVisibility,
} from "@densio/shared";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { Option, Schema } from "effect";
import type { Database } from "../database/database.ts";
import { storageSettings, storageTransfers, videos } from "../database/video-storage-schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { readVideo } from "./video-catalog.ts";
import { storageDefaults, storageUsage, validateDestination } from "./storage-policy.ts";
import type { VideoServiceConfig } from "./video-config.ts";

const Cursor = Schema.Struct({
  organizationId: Schema.String,
  createdAt: Schema.Number,
  id: Schema.String,
  state: Schema.optionalKey(VideoStateSchema),
});
export const listVideos = (
  database: Database,
  input: OrganizationActor & {
    readonly limit?: number;
    readonly cursor?: string;
    readonly state?: typeof VideoStateSchema.Type;
  },
) => {
  authorizeOrganization(database.db, input, "media-read");
  const decoded = input.cursor
    ? Schema.decodeUnknownOption(Schema.fromJsonString(Cursor))(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      )
    : undefined;
  if (decoded && Option.isNone(decoded)) throw storageFailure("INVALID_REQUEST");
  const after = decoded && Option.isSome(decoded) ? decoded.value : undefined;
  if (after && (after.organizationId !== input.organizationId || after.state !== input.state))
    throw storageFailure("INVALID_REQUEST");
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw storageFailure("INVALID_REQUEST");
  const rows = database.db
    .select()
    .from(videos)
    .where(
      and(
        eq(videos.organizationId, input.organizationId),
        input.state ? eq(videos.state, input.state) : undefined,
        after
          ? or(
              gt(videos.createdAt, after.createdAt),
              and(eq(videos.createdAt, after.createdAt), gt(videos.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(asc(videos.createdAt), asc(videos.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    organizationId: input.organizationId,
    videos: page.map((row) => readVideo(database, input.organizationId, row.id)),
    ...(rows.length > limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              organizationId: input.organizationId,
              createdAt: last.createdAt,
              id: last.id,
              state: input.state,
            }),
          ).toString("base64url"),
        }
      : {}),
  };
};
export const getVideo = (
  database: Database,
  input: OrganizationActor & { readonly videoId: string },
) => {
  authorizeOrganization(database.db, input, "media-read");
  return {
    organizationId: input.organizationId,
    video: readVideo(database, input.organizationId, input.videoId),
  };
};
export const getStorageUsage = (
  database: Database,
  config: VideoServiceConfig,
  input: OrganizationActor,
) => {
  authorizeOrganization(database.db, input, "media-read");
  return {
    organizationId: input.organizationId,
    usage: storageUsage(database, config, input.organizationId),
  };
};
export const getStorageSettings = (database: Database, input: OrganizationActor) => {
  authorizeOrganization(database.db, input, "media-read");
  return {
    organizationId: input.organizationId,
    settings: storageDefaults(database, input.organizationId),
  };
};
export const updateStorageSettings = (
  database: Database,
  config: VideoServiceConfig,
  input: OrganizationActor & {
    readonly destination: StorageDestination;
    readonly visibility: StorageVisibility;
  },
) =>
  database.db.transaction((transaction) => {
    authorizeOrganization(transaction, input, "storage-configure");
    if (input.destination.kind !== "temporary")
      validateDestination(
        database,
        config,
        input.organizationId,
        input.destination,
        input.visibility,
      );
    transaction
      .insert(storageSettings)
      .values({
        organizationId: input.organizationId,
        destinationJson: JSON.stringify(input.destination),
        visibility: input.visibility,
        updatedAt: config.now(),
      })
      .onConflictDoUpdate({
        target: storageSettings.organizationId,
        set: {
          destinationJson: JSON.stringify(input.destination),
          visibility: input.visibility,
          updatedAt: config.now(),
        },
      })
      .run();
    return getStorageSettings(database, input);
  });
export const getStorageTransfer = (
  database: Database,
  input: OrganizationActor & { readonly transferId: string },
) => {
  authorizeOrganization(database.db, input, "media-read");
  const row = database.db
    .select()
    .from(storageTransfers)
    .where(
      and(
        eq(storageTransfers.organizationId, input.organizationId),
        eq(storageTransfers.id, input.transferId),
      ),
    )
    .get();
  if (!row) throw storageFailure("STORAGE_TRANSFER_NOT_FOUND");
  return {
    organizationId: input.organizationId,
    transfer: Schema.decodeUnknownSync(StorageTransferSchema)({
      organizationId: input.organizationId,
      transferId: row.id,
      videoId: row.videoId,
      kind: row.kind,
      state: row.state,
      attempts: row.attempts,
      recoveryDeadline: new Date(row.recoveryDeadline).toISOString(),
      ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
      nextAttemptAt: new Date(row.nextAttemptAt).toISOString(),
    }),
  };
};
