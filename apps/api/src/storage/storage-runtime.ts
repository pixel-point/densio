import { makeStorageTargets } from "./storage-targets.ts";
import { maintainManagedInventory } from "./managed/storage-inventory.ts";
import { maintainStorageHealth } from "./managed/storage-health.ts";
import { maintainStoragePolicy } from "./managed/storage-retention.ts";
import type { makePreparedSourceService } from "../sources/prepared-source-service.ts";
import { makeSourceUploadService } from "./uploads/source-upload-service.ts";
import { makeSourceUploadWorker } from "./uploads/source-upload-worker.ts";
import { streamGrantedHls } from "../videos/hls-download.ts";
import { streamGrantedVideo } from "../videos/video-stream.ts";
import { Effect } from "effect";
import type { AppConfig } from "../config.ts";
import type { Database } from "../database/database.ts";
import { makeVideoService } from "../videos/video-service.ts";
import { makeStorageConnectionService } from "./connections/connection-service.ts";
import { makeConnectionWorker } from "./connections/connection-worker.ts";
import { verifyPublicVideo } from "./objects/public-delivery.ts";
import { managedTargetId } from "./storage-config.ts";
import { makeStorageWorker } from "./transfers/storage-worker.ts";

export const makeStorageRuntime = (
  database: Database,
  config: AppConfig,
  sourceService: ReturnType<typeof makePreparedSourceService>,
) => {
  const active = config.storage.managedTargets.find(
    (target) => target.name === config.storage.activeManagedTarget,
  );
  const videoConfig = {
    now: Date.now,
    priceIds: config.billing.priceIds,
    mediaRoot: config.mediaRoot,
    publicBaseUrl: config.publicBaseUrl,
    ...(active
      ? { managedTargetId: managedTargetId(active), managedPublicOrigin: active.publicOrigin }
      : {}),
  };
  const connectionsConfig = {
    now: Date.now,
    credentialKeys: config.storage.credentialKeys,
    activeCredentialKey: config.storage.activeCredentialKey,
  };
  const { resolveTarget, purge } = makeStorageTargets(database, config, connectionsConfig);
  const workerConfig = {
    ...videoConfig,
    resolveTarget,
    verifyPublic: (
      url: string,
      bytes: number,
      mediaType: string,
      signal?: AbortSignal,
      hls?: boolean,
    ) => verifyPublicVideo(url, bytes, mediaType, [], signal, hls),
    purge,
  };
  const worker = makeStorageWorker(database, workerConfig);
  const connectionWorker = makeConnectionWorker(database, connectionsConfig);
  const sourceConfig = {
    now: Date.now,
    sourceService,
    sourceTtlMs: config.sourceTtlMs,
    uploadTtlMs: config.uploadTtlMs,
    publicBaseUrl: config.publicBaseUrl,
    resolveTarget,
  };
  const sourceUploads = makeSourceUploadService(database, sourceConfig);
  const sourceWorker = makeSourceUploadWorker(database, sourceConfig);
  return {
    maintainPolicy: () =>
      Effect.all(
        [
          maintainStoragePolicy(database, videoConfig),
          maintainStorageHealth(database, workerConfig),
          maintainManagedInventory(database, {
            now: Date.now,
            targets: config.storage.managedTargets.map((target) => ({
              id: managedTargetId(target),
              roles: ["public", "private", "staging"] as const,
            })),
            resolveTarget,
            purge,
          }),
        ],
        { discard: true },
      ),
    sourceUploads,
    downloadPackage: (input: Parameters<typeof streamGrantedHls>[2]) =>
      streamGrantedHls(database, workerConfig, input),
    download: (input: Parameters<typeof streamGrantedVideo>[2]) =>
      streamGrantedVideo(database, workerConfig, input),
    videoConfig,
    workerConfig,
    videoService: makeVideoService(database, videoConfig),
    connectionService: makeStorageConnectionService(database, connectionsConfig),
    maintainConnections: connectionWorker.maintain,
    maintainSourceUploads: sourceWorker.maintain,
    maintainTransfers: worker.maintain,
  };
};
