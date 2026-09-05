import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import { videos } from "../../database/video-storage-schema.ts";

export const storagePurgeCandidates = (
  database: Database,
  organizationId: string,
  limit: number,
) => {
  const rows = database.db
    .select()
    .from(videos)
    .where(
      and(
        eq(videos.organizationId, organizationId),
        isNull(videos.connectionId),
        inArray(videos.capacityState, ["used", "reserved"]),
      ),
    )
    .orderBy(desc(videos.storedAt), desc(videos.id))
    .all();
  const total = rows.reduce((sum, row) => sum + row.totalBytes, 0);
  return rows.reduce<{ bytes: number; ids: string[] }>(
    (result, row) =>
      result.bytes <= limit
        ? result
        : { bytes: result.bytes - row.totalBytes, ids: [...result.ids, row.id] },
    { bytes: total, ids: [] },
  ).ids;
};
