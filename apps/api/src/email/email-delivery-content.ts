import { storageRetentionEmailInput } from "./storage-retention-email.ts";
import {
  renderSignInConfirmationEmail,
  renderOrganizationInvitationEmail,
  renderStorageRetentionEmail,
} from "@densio/emails";
import { eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { authChallenges } from "../database/schema.ts";
import { deliverableInvitation } from "../database/organization-invitation-repository.ts";
import type { MagicLinkOpener } from "../auth/magic-link-secret.ts";
import type { OrganizationInvitationLinks } from "../organizations/organization-invitation-link.ts";
import { decodeEmailOutboxPayload } from "./email-outbox-payload.ts";
import type { OutboxEmail } from "./email-outbox-repository.ts";

export const emailDeliveryContent = (
  database: Database,
  email: OutboxEmail,
  now: number,
  openMagicLink: MagicLinkOpener,
  invitationLinks: OrganizationInvitationLinks,
) => {
  const payload = decodeEmailOutboxPayload(email.payloadJson);
  if (payload.kind === "storage-retention") {
    const input = storageRetentionEmailInput(database, email.recipient, payload, now);
    return input
      ? {
          render: () => renderStorageRetentionEmail(input),
          idempotencyKey: `storage-retention-email-${email.id}`,
        }
      : undefined;
  }
  if (payload.kind === "organization-invitation") {
    const record = deliverableInvitation(database.db, payload.invitationId, now);
    if (record === undefined || record.invitation.email !== email.recipient) return undefined;
    return {
      render: () =>
        renderOrganizationInvitationEmail({
          name: record.organization.name,
          acceptanceUrl: invitationLinks.url(record.invitation),
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
    render: () =>
      renderSignInConfirmationEmail({
        verificationUrl,
      }),
    idempotencyKey: `auth-email-${email.id}`,
  };
};
