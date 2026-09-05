import {
  DEFAULT_COMPRESSION_CODECS,
  type ExecutionPlanCreateRequest,
  type ResolvedStoragePlan,
  type StoredVideoPlan,
} from "@densio/shared";
import type { Database } from "../database/database.ts";
import { filenameStem, variantFilename } from "../storage/managed/object-key.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { storageDefaults, storageUsage, validateDestination } from "./storage-policy.ts";
import type { VideoServiceConfig } from "./video-config.ts";

export const resolveStoragePlan = (
  database: Database,
  config: VideoServiceConfig,
  organizationId: string,
  sourceFilename: string,
  request: Extract<ExecutionPlanCreateRequest, { workflow: "compress" | "trim" | "hls" }>,
): ResolvedStoragePlan => {
  const defaults = storageDefaults(database, organizationId);
  const destination = request.storage?.destination ?? defaults.destination;
  if (destination.kind === "temporary") {
    if (request.storage?.visibility || request.storage?.name)
      throw storageFailure(
        "INVALID_REQUEST",
        "Video naming and visibility require a storage destination.",
      );
    return { destination };
  }
  const visibility = request.storage?.visibility ?? defaults.visibility;
  const location = validateDestination(database, config, organizationId, destination, visibility);
  const stem = filenameStem(request.storage?.name, sourceFilename);
  const usage =
    destination.kind === "managed" ? storageUsage(database, config, organizationId) : undefined;
  return {
    destination,
    visibility,
    displayName: request.storage?.name ?? sourceFilename.replace(/\.[^.]*$/, ""),
    filenameStem: stem,
    targetId: location.targetId,
    keyPrefix: location.prefix,
    ...(location.publicOrigin ? { publicOrigin: location.publicOrigin } : {}),
    files:
      request.workflow === "hls"
        ? [{ codec: "h265", filename: "master.m3u8", kind: "hls-package" }]
        : (request.workflow === "trim"
            ? [request.options.output.codec]
            : (request.options?.codecs ?? DEFAULT_COMPRESSION_CODECS)
          ).map((codec) => ({
            codec,
            filename: variantFilename(stem, codec),
          })),
    ...(usage
      ? {
          capacity: {
            includedStorageBytes: usage.includedStorageBytes,
            usedBytes: usage.usedBytes,
            reservedBytes: usage.reservedBytes,
          },
        }
      : {}),
  } satisfies StoredVideoPlan;
};
