import { createOpaqueToken, formatOpaqueToken, hashTokenSecret } from "../auth/opaque-token.ts";
import { and, eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { organizationMemberships, organizations } from "../database/organization-schema.ts";
import {
  storageObjects,
  videoAccessGrants,
  videoVariants,
  videos,
} from "../database/video-storage-schema.ts";
import { authorizeOrganization } from "../organizations/organization-access.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { requireActiveConnection } from "../storage/connections/connection-catalog.ts";
import type { VideoServiceConfig } from "./video-config.ts";
import type { OwnedVideoInput } from "./video-mutations.ts";

export const authorizeVideoDownload = (
  database: Database,
  config: VideoServiceConfig,
  input: OwnedVideoInput & { readonly variantId: string },
) =>
  database.db.transaction((transaction) => {
    authorizeOrganization(transaction, input, "media-read");
    const variant = transaction
      .select()
      .from(videoVariants)
      .where(
        and(
          eq(videoVariants.id, input.variantId),
          eq(videoVariants.organizationId, input.organizationId),
          eq(videoVariants.videoId, input.videoId),
        ),
      )
      .get();
    const video = transaction
      .select()
      .from(videos)
      .where(and(eq(videos.id, input.videoId), eq(videos.organizationId, input.organizationId)))
      .get();
    if (!variant || video?.state !== "ready" || !variant.activeObjectId)
      throw storageFailure("VIDEO_NOT_FOUND");
    if (video.connectionId !== null)
      requireActiveConnection(database, video.organizationId, video.connectionId);
    const token = createOpaqueToken();
    const expiresAt = config.now() + 900_000;
    transaction
      .insert(videoAccessGrants)
      .values({
        id: token.publicId,
        organizationId: input.organizationId,
        variantId: variant.id,
        membershipId: input.membershipId,
        tokenHash: hashTokenSecret(token.secret),
        expiresAt,
        createdAt: config.now(),
      })
      .run();
    return {
      organizationId: input.organizationId,
      videoId: video.id,
      variantId: variant.id,
      download: {
        method: "GET" as const,
        expiresAt: new Date(expiresAt).toISOString(),
        url: new URL(
          `/v1/video-downloads/${variant.id}/${formatOpaqueToken(token)}/${variant.filename}`,
          config.publicBaseUrl,
        ).toString(),
      },
    };
  });

export const findGrantedVideo = (
  database: Database,
  input: { readonly variantId: string; readonly token: string; readonly now: number },
) => {
  const [id, secret, extra] = input.token.split(".");
  if (!id || !secret || extra !== undefined) throw storageFailure("VIDEO_NOT_FOUND");
  const grant = database.db
    .select()
    .from(videoAccessGrants)
    .where(
      and(
        eq(videoAccessGrants.id, id),
        eq(videoAccessGrants.variantId, input.variantId),
        eq(videoAccessGrants.tokenHash, hashTokenSecret(secret)),
      ),
    )
    .get();
  if (!grant || grant.expiresAt <= input.now) throw storageFailure("VIDEO_NOT_FOUND");
  const membership = database.db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.id, grant.membershipId),
        eq(organizationMemberships.organizationId, grant.organizationId),
      ),
    )
    .get();
  const organization = database.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, grant.organizationId))
    .get();
  const variant = database.db
    .select()
    .from(videoVariants)
    .where(
      and(
        eq(videoVariants.id, grant.variantId),
        eq(videoVariants.organizationId, grant.organizationId),
      ),
    )
    .get();
  const video = variant
    ? database.db
        .select()
        .from(videos)
        .where(and(eq(videos.id, variant.videoId), eq(videos.organizationId, grant.organizationId)))
        .get()
    : undefined;
  const object = variant?.activeObjectId
    ? database.db
        .select()
        .from(storageObjects)
        .where(
          and(
            eq(storageObjects.id, variant.activeObjectId),
            eq(storageObjects.organizationId, grant.organizationId),
          ),
        )
        .get()
    : undefined;
  if (
    !membership ||
    organization?.state !== "active" ||
    !variant ||
    video?.state !== "ready" ||
    object?.state !== "verified"
  )
    throw storageFailure("VIDEO_NOT_FOUND");
  if (video.connectionId !== null)
    requireActiveConnection(database, video.organizationId, video.connectionId);
  return { variant, video, object };
};
