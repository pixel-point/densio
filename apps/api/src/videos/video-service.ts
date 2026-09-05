import { exportVideo } from "./video-export.ts";
import { recoverVideo } from "./video-recovery.ts";
import { authorizeVideoDownload } from "./video-download.ts";
import { authorizeHlsDownload } from "./hls-download.ts";
import {
  getStorageSettings,
  getStorageTransfer,
  getStorageUsage,
  getVideo,
  listVideos,
  updateStorageSettings,
} from "./video-queries.ts";
import type { StorageVisibility } from "@densio/shared";
import { mutateVideo, renameVideo, type OwnedVideoInput } from "./video-mutations.ts";
import type { Database } from "../database/database.ts";
import { storageEffect } from "../storage/storage-errors.ts";
import type { VideoServiceConfig } from "./video-config.ts";
import { saveVideo, type SaveVideoInput } from "./video-save.ts";

export const makeVideoService = (database: Database, config: VideoServiceConfig) => ({
  authorizePackage: (input: OwnedVideoInput) =>
    storageEffect("video-service", () => authorizeHlsDownload(database, config, input)),
  export: (input: Parameters<typeof exportVideo>[2]) =>
    storageEffect("video-service", () => exportVideo(database, config, input)),
  recover: (input: Parameters<typeof recoverVideo>[2]) =>
    storageEffect("video-service", () => recoverVideo(database, config, input)),
  retry: (input: Omit<Parameters<typeof recoverVideo>[2], "action">) =>
    storageEffect("video-service", () =>
      recoverVideo(database, config, { ...input, action: "retry" }),
    ),
  authorize: (input: Parameters<typeof authorizeVideoDownload>[2]) =>
    storageEffect("video-service", () => authorizeVideoDownload(database, config, input)),
  get: (input: Parameters<typeof getVideo>[1]) =>
    storageEffect("video-service", () => getVideo(database, input)),
  list: (input: Parameters<typeof listVideos>[1]) =>
    storageEffect("video-service", () => listVideos(database, input)),
  usage: (input: Parameters<typeof getStorageUsage>[2]) =>
    storageEffect("video-service", () => getStorageUsage(database, config, input)),
  settings: (input: Parameters<typeof getStorageSettings>[1]) =>
    storageEffect("video-service", () => getStorageSettings(database, input)),
  updateSettings: (input: Parameters<typeof updateStorageSettings>[2]) =>
    storageEffect("video-service", () => updateStorageSettings(database, config, input)),
  transfer: (input: Parameters<typeof getStorageTransfer>[1]) =>
    storageEffect("video-service", () => getStorageTransfer(database, input)),
  changeVisibility: (
    input: OwnedVideoInput & {
      readonly visibility: StorageVisibility;
      readonly idempotencyKey: string;
    },
  ) => storageEffect("video-service", () => mutateVideo(database, config, input)),
  remove: (
    input: OwnedVideoInput & { readonly idempotencyKey: string; readonly deleteObjects?: boolean },
  ) => storageEffect("video-service", () => mutateVideo(database, config, input)),
  rename: (input: OwnedVideoInput & { readonly name: string }) =>
    storageEffect("video-service", () => renameVideo(database, input)),
  save: (input: SaveVideoInput) =>
    storageEffect("video-service", () => saveVideo(database, config, input)),
});
