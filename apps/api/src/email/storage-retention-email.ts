import { eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { organizations } from "../database/schema.ts";
import { storageSettings } from "../database/video-storage-schema.ts";

export const storageRetentionEmailInput = (
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
  return {
    organizationName: organization.name,
    deadline: payload.deadline,
  };
};
