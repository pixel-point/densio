import type { Database } from "../../database/database.ts";
import type { storageTransfers } from "../../database/video-storage-schema.ts";
import type { VideoServiceConfig } from "../../videos/video-config.ts";
import type { StorageTarget } from "../objects/object-store.ts";

export interface StorageWorkerConfig extends VideoServiceConfig {
  readonly resolveTarget: (
    targetId: string,
    role: "public" | "private" | "staging",
  ) => Promise<StorageTarget>;
  readonly verifyPublic: (
    url: string,
    bytes: number,
    mediaType: string,
    signal?: AbortSignal,
    hls?: boolean,
  ) => Promise<void>;
  readonly purge: (urls: readonly string[], signal?: AbortSignal) => Promise<void>;
  readonly writerIdentity?: string;
  readonly isWriterAlive?: (pid: number, identity: string) => boolean;
}
export interface TransferContext {
  readonly database: Database;
  readonly config: StorageWorkerConfig;
  readonly transfer: typeof storageTransfers.$inferSelect;
  readonly signal: AbortSignal;
  readonly assertActive: () => void;
}
