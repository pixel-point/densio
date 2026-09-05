import { hlsPackages } from "../database/schema.ts";
import {
  HlsPackageSchema,
  StoredDestinationSchema,
  VideoSchema,
  type VideoVariant,
} from "@densio/shared";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import type { Database } from "../database/database.ts";
import { videoVariants, videoPackageMembers, videos } from "../database/video-storage-schema.ts";
import { storageFailure } from "../storage/storage-errors.ts";

export const readVideo = (database: Database, organizationId: string, videoId: string) => {
  const row = database.db
    .select()
    .from(videos)
    .where(and(eq(videos.organizationId, organizationId), eq(videos.id, videoId)))
    .get();
  if (row === undefined) throw storageFailure("VIDEO_NOT_FOUND");
  const publicReady =
    row.state === "ready" && row.visibility === "public" && row.publicOrigin !== null;
  const variants: VideoVariant[] = database.db
    .select()
    .from(videoVariants)
    .where(
      and(eq(videoVariants.videoId, videoId), eq(videoVariants.organizationId, organizationId)),
    )
    .all()
    .map((variant) => ({
      variantId: variant.id,
      filename: variant.filename,
      codec: variant.codec,
      mediaType: variant.mediaType,
      bytes: variant.bytes,
      sha256: variant.sha256,
      ...(variant.width === null ? {} : { width: variant.width }),
      ...(variant.height === null ? {} : { height: variant.height }),
      ...(variant.durationSeconds === null ? {} : { durationSeconds: variant.durationSeconds }),
      ...(publicReady
        ? { publicUrl: publicObjectUrl(row.publicOrigin ?? "", variant.publicKey) }
        : {}),
    }));
  const hls = row.hlsPackageId === null ? undefined : readHlsPackage(database, row, publicReady);
  return Schema.decodeUnknownSync(VideoSchema)({
    organizationId,
    videoId,
    jobId: row.jobId,
    displayName: row.displayName,
    filenameStem: row.filenameStem,
    destination: Schema.decodeUnknownSync(Schema.fromJsonString(StoredDestinationSchema))(
      row.destinationJson,
    ),
    visibility: row.visibility,
    visibilityRevision: row.visibilityRevision,
    state: row.state,
    variants,
    ...(hls === undefined ? {} : { hls }),
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.storedAt === null ? {} : { storedAt: new Date(row.storedAt).toISOString() }),
    transferId: row.transferId,
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    ...(publicReady
      ? {
          embedHtml: hls?.playbackUrl
            ? `<video controls playsinline preload="metadata" src="${escapeAttribute(hls.playbackUrl)}"></video>`
            : videoEmbed(variants),
        }
      : {}),
  });
};

export const publicObjectUrl = (origin: string, key: string) =>
  `${origin.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const videoEmbed = (variants: readonly VideoVariant[]) =>
  `<video controls playsinline preload="metadata">\n${variants
    .filter((variant) => variant.publicUrl !== undefined)
    .map(
      (variant) =>
        `  <source src="${escapeAttribute(variant.publicUrl ?? "")}" type="${variant.mediaType}">`,
    )
    .join("\n")}\n</video>`;

const readHlsPackage = (
  database: Database,
  video: typeof videos.$inferSelect,
  publicReady: boolean,
) => {
  const row = database.db
    .select()
    .from(hlsPackages)
    .where(eq(hlsPackages.id, video.hlsPackageId ?? ""))
    .get();
  const master = database.db
    .select()
    .from(videoPackageMembers)
    .where(and(eq(videoPackageMembers.videoId, video.id), eq(videoPackageMembers.role, "master")))
    .get();
  if (!row || !master) throw storageFailure("STORAGE_OBJECT_CHANGED");
  const contents = Schema.decodeUnknownSync(Schema.fromJsonString(HlsPackageSchema))(
    row.inventoryJson,
  );
  return {
    packageId: contents.packageId,
    masterPlaylist: contents.masterPlaylist,
    packageBytes: contents.packageBytes,
    renditions: contents.renditions,
    ...(publicReady
      ? { playbackUrl: publicObjectUrl(video.publicOrigin ?? "", master.publicKey) }
      : {}),
  };
};
