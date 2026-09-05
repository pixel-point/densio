import { HlsPackageSchema, HlsMemberPathSchema } from "@densio/shared";
import { Schema } from "effect";
import { and, eq, lte } from "drizzle-orm";
import { createOpaqueToken, formatOpaqueToken, hashTokenSecret } from "../auth/opaque-token.ts";
import type { Database } from "../database/database.ts";
import { hlsPackages, organizationMemberships, organizations } from "../database/schema.ts";
import {
  hlsAccessGrants,
  storageObjects,
  videoPackageMembers,
  videos,
} from "../database/video-storage-schema.ts";
import { authorizeOrganization } from "../organizations/organization-access.ts";
import { requireActiveConnection } from "../storage/connections/connection-catalog.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import type { StorageWorkerConfig } from "../storage/transfers/transfer-context.ts";
import type { VideoServiceConfig } from "./video-config.ts";
import type { OwnedVideoInput } from "./video-mutations.ts";
import { streamGrantedFile, type StoredFileRequest } from "./video-stream.ts";

export const authorizeHlsDownload = (
  database: Database,
  config: VideoServiceConfig,
  input: OwnedVideoInput,
) =>
  database.db.transaction((transaction) => {
    authorizeOrganization(transaction, input, "media-read");
    const video = transaction
      .select()
      .from(videos)
      .where(and(eq(videos.id, input.videoId), eq(videos.organizationId, input.organizationId)))
      .get();
    if (video?.state !== "ready" || !video.hlsPackageId) throw storageFailure("VIDEO_NOT_FOUND");
    if (video.connectionId)
      requireActiveConnection(database, video.organizationId, video.connectionId);
    const inventory = transaction
      .select()
      .from(hlsPackages)
      .where(
        and(
          eq(hlsPackages.id, video.hlsPackageId),
          eq(hlsPackages.organizationId, input.organizationId),
        ),
      )
      .get();
    if (!inventory) throw storageFailure("VIDEO_NOT_FOUND");
    const contents = Schema.decodeUnknownSync(Schema.fromJsonString(HlsPackageSchema))(
      inventory.inventoryJson,
    );
    const token = createOpaqueToken();
    const expiresAt = config.now() + 900_000;
    transaction.delete(hlsAccessGrants).where(lte(hlsAccessGrants.expiresAt, config.now())).run();
    transaction
      .insert(hlsAccessGrants)
      .values({
        id: token.publicId,
        organizationId: input.organizationId,
        videoId: video.id,
        membershipId: input.membershipId,
        tokenHash: hashTokenSecret(token.secret),
        revision: video.visibilityRevision,
        expiresAt,
        createdAt: config.now(),
      })
      .run();
    return {
      organizationId: input.organizationId,
      videoId: video.id,
      package: contents,
      download: {
        method: "GET" as const,
        expiresAt: new Date(expiresAt).toISOString(),
        baseUrl: new URL(
          `/v1/hls-downloads/${video.id}/${formatOpaqueToken(token)}/`,
          config.publicBaseUrl,
        ).toString(),
      },
    };
  });

export const streamGrantedHls = (
  database: Database,
  config: StorageWorkerConfig,
  input: StoredFileRequest & { readonly videoId: string; readonly token: string },
) =>
  streamGrantedFile(database, config, input, () =>
    findGrantedHlsMember(database, { ...input, now: config.now() }),
  );

const findGrantedHlsMember = (
  database: Database,
  input: { videoId: string; token: string; filename: string; now: number },
) => {
  const [id, secret, extra] = input.token.split(".");
  if (!id || !secret || extra !== undefined || !Schema.is(HlsMemberPathSchema)(input.filename))
    throw storageFailure("VIDEO_NOT_FOUND");
  const grant = database.db
    .select({ grant: hlsAccessGrants, video: videos })
    .from(hlsAccessGrants)
    .innerJoin(
      videos,
      and(
        eq(videos.id, hlsAccessGrants.videoId),
        eq(videos.organizationId, hlsAccessGrants.organizationId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, hlsAccessGrants.organizationId))
    .innerJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.id, hlsAccessGrants.membershipId),
        eq(organizationMemberships.organizationId, hlsAccessGrants.organizationId),
      ),
    )
    .where(
      and(
        eq(hlsAccessGrants.id, id),
        eq(hlsAccessGrants.videoId, input.videoId),
        eq(hlsAccessGrants.tokenHash, hashTokenSecret(secret)),
        eq(organizations.state, "active"),
      ),
    )
    .get();
  if (
    !grant ||
    grant.grant.expiresAt <= input.now ||
    grant.video.state !== "ready" ||
    grant.grant.revision !== grant.video.visibilityRevision
  )
    throw storageFailure("VIDEO_NOT_FOUND");
  if (grant.video.connectionId)
    requireActiveConnection(database, grant.video.organizationId, grant.video.connectionId);
  const member = database.db
    .select({ variant: videoPackageMembers, object: storageObjects })
    .from(videoPackageMembers)
    .innerJoin(
      storageObjects,
      and(
        eq(storageObjects.id, videoPackageMembers.activeObjectId),
        eq(storageObjects.organizationId, videoPackageMembers.organizationId),
      ),
    )
    .where(
      and(
        eq(videoPackageMembers.videoId, input.videoId),
        eq(videoPackageMembers.organizationId, grant.video.organizationId),
        eq(videoPackageMembers.filename, input.filename),
        eq(storageObjects.state, "verified"),
      ),
    )
    .get();
  if (!member) throw storageFailure("VIDEO_NOT_FOUND");
  return member;
};
