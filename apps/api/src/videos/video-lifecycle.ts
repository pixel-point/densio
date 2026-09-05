import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../database/database.ts";
import { videos } from "../database/video-storage-schema.ts";

type Video = typeof videos.$inferSelect;
type State = Video["state"];
const transitions: Record<State, readonly State[]> = {
  storing: [
    "storing",
    "ready",
    "storage-blocked",
    "storage-failed",
    "deleting",
    "deleted",
    "unavailable",
  ],
  ready: ["ready", "visibility-changing", "deleting", "deleted", "unavailable"],
  "storage-blocked": [
    "storing",
    "storage-blocked",
    "storage-failed",
    "deleting",
    "deleted",
    "unavailable",
  ],
  "storage-failed": ["storing", "storage-failed", "deleting", "deleted", "unavailable"],
  unavailable: ["unavailable", "ready", "storing", "deleting", "deleted"],
  "visibility-changing": ["visibility-changing", "ready", "deleting"],
  deleting: ["deleting", "deleted", "ready", "storage-failed"],
  deleted: ["deleted"],
};

// A delayed observer or superseded worker cannot change a newer operation's state.
export const transitionVideo = (
  transaction: DatabaseTransaction,
  previous: Video,
  update: Pick<Video, "state"> &
    Partial<
      Pick<
        Video,
        | "errorCode"
        | "storedAt"
        | "deletedAt"
        | "capacityState"
        | "transferId"
        | "visibility"
        | "visibilityRevision"
      >
    >,
) => {
  if (!transitions[previous.state].includes(update.state)) return undefined;
  return transaction
    .update(videos)
    .set(update)
    .where(
      and(
        eq(videos.id, previous.id),
        eq(videos.organizationId, previous.organizationId),
        eq(videos.state, previous.state),
        eq(videos.visibilityRevision, previous.visibilityRevision),
        eq(videos.transferId, previous.transferId),
      ),
    )
    .returning()
    .get();
};
