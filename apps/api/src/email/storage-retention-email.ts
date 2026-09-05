import { eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { organizations } from "../database/schema.ts";
import { storageSettings } from "../database/video-storage-schema.ts";

export const storageRetentionEmail = (
  database: Database,
  recipient: string,
  payload: { organizationId: string; revision: number; deadline: number },
  now: number,
) => {
  const organization = database.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, payload.organizationId))
    .get();
  const settings = database.db
    .select()
    .from(storageSettings)
    .where(eq(storageSettings.organizationId, payload.organizationId))
    .get();
  if (
    organization?.state !== "active" ||
    organization.billingEmail !== recipient ||
    settings?.policyRevision !== payload.revision ||
    settings.graceDeadline !== payload.deadline ||
    payload.deadline <= now
  )
    return undefined;
  const text = `${organization.name} exceeds its current Densio video storage allowance.\n\nYour existing videos remain available until ${new Date(payload.deadline).toISOString()}. After that date, Densio removes managed videos until usage fits your plan (all managed videos on Free), starting with the newest stored groups. This breaks their public links and embeds.\n\nReview affected video IDs with:\ndensio --org ${organization.id} storage usage\n\nBefore the deadline, upgrade, delete videos, or export them to your own S3-compatible storage. Exporting does not automatically delete the managed copy.\n\ndensio --org ${organization.id} videos export VIDEO_ID --destination CONNECTION_ID --idempotency-key EXPORT_KEY`;
  return {
    subject: "Action required: Densio video storage retention",
    text,
    html: `<html><body><pre>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre></body></html>`,
  };
};
