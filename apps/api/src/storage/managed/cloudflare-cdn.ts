import { Schema } from "effect";
import { storageFailure } from "../storage-errors.ts";

const PurgeResult = Schema.Struct({ success: Schema.Boolean });
export const makeCloudflarePurger =
  (zoneId: string, token: string) => async (urls: readonly string[], signal?: AbortSignal) => {
    if (!/^[a-f0-9]{32}$/.test(zoneId) || token === "")
      throw storageFailure("STORAGE_NOT_CONFIGURED");
    for (let start = 0; start < urls.length; start += 30) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
        {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ files: urls.slice(start, start + 30) }),
          signal:
            signal === undefined
              ? AbortSignal.timeout(30_000)
              : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        },
      ).catch(() => {
        throw storageFailure("STORAGE_DELETION_BLOCKED");
      });
      if (!response.ok) throw storageFailure("STORAGE_DELETION_BLOCKED");
      const result = await Schema.decodeUnknownPromise(PurgeResult)(await response.json()).catch(
        () => {
          throw storageFailure("STORAGE_DELETION_BLOCKED");
        },
      );
      if (!result.success) throw storageFailure("STORAGE_DELETION_BLOCKED");
    }
  };
