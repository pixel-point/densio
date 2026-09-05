import { storageRetentionEmail } from "./storage-retention-email.ts";
import { eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { authChallenges } from "../database/schema.ts";
import { deliverableInvitation } from "../database/organization-invitation-repository.ts";
import type { MagicLinkOpener } from "../auth/magic-link-secret.ts";
import { renderMagicLinkEmail } from "../auth/magic-link-email.ts";
import { renderOrganizationInvitationEmail } from "./organization-invitation-email.ts";
import { decodeEmailOutboxPayload } from "./email-outbox-payload.ts";
import type { OutboxEmail } from "./email-outbox-repository.ts";

export const emailDeliveryContent = (
  database: Database,
  email: OutboxEmail,
  now: number,
  openMagicLink: MagicLinkOpener,
) => {
  const payload = decodeEmailOutboxPayload(email.payloadJson);
  if (payload.kind === "storage-retention") {
    const content = storageRetentionEmail(database, email.recipient, payload, now);
    return content
      ? { ...content, idempotencyKey: `storage-retention-email-${email.id}` }
      : undefined;
  }
  if (payload.kind === "organization-invitation") {
    const record = deliverableInvitation(database.db, payload.invitationId, now);
    if (record === undefined || record.invitation.email !== email.recipient) return undefined;
    return {
      ...renderOrganizationInvitationEmail({
        name: record.organization.name,
        invitationId: record.invitation.id,
        expiresAt: record.invitation.expiresAt,
      }),
      idempotencyKey: `organization-invitation-email-${email.id}`,
    };
  }
  const challenge = database.db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.id, payload.challengeId))
    .get();
  if (
    challenge === undefined ||
    challenge.email !== email.recipient ||
    challenge.status !== "pending" ||
    challenge.expiresAt <= now
  )
    return undefined;
  const verificationUrl = openMagicLink(payload.encryptedConfirmationUrl, {
    challengeId: payload.challengeId,
    emailId: email.id,
    recipient: email.recipient,
  });
  return {
    ...renderMagicLinkEmail({
      verificationUrl,
      expiresInMinutes: Math.max(1, Math.ceil((challenge.expiresAt - now) / 60_000)),
    }),
    idempotencyKey: `auth-email-${email.id}`,
  };
};
