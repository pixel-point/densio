import type { makePreparedSourceService } from "../../sources/prepared-source-service.ts";
import type { StorageTarget } from "../objects/object-store.ts";
export interface SourceUploadConfig {
  readonly now: () => number;
  readonly sourceTtlMs: number;
  readonly uploadTtlMs: number;
  readonly publicBaseUrl: string;
  readonly sourceService: Pick<
    ReturnType<typeof makePreparedSourceService>,
    "status" | "ingestObject"
  >;
  readonly resolveTarget: (targetId: string, role: "staging") => Promise<StorageTarget>;
  readonly writerIdentity?: string;
  readonly isWriterAlive?: (pid: number, identity: string) => boolean;
}
