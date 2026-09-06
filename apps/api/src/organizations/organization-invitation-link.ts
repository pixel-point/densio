import { createHmac } from "node:crypto";
import {
  formatOpaqueToken,
  hashTokenSecret,
  ParsedOpaqueToken,
  verifyTokenSecret,
} from "../auth/opaque-token.ts";
import type { organizationInvitations } from "../database/schema.ts";

type Invitation = typeof organizationInvitations.$inferSelect;

export const makeOrganizationInvitationLinks = (keyHex: string, publicBaseUrl: string) => {
  if (!/^[\dA-Fa-f]{64}$/u.test(keyHex)) throw new Error("Invalid invitation signing key.");
  // Separate invitation credentials from every other use of the protected outbox key.
  const signingKey = createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update("densio:organization-invitation:v1")
    .digest();
  const secret = (invitation: Invitation) =>
    createHmac("sha256", signingKey)
      .update(
        JSON.stringify([
          invitation.id,
          invitation.organizationId,
          invitation.email,
          invitation.role,
          invitation.invitedByUserId,
          invitation.expiresAt,
        ]),
      )
      .digest("base64url");
  return {
    url: (invitation: Invitation) => {
      const url = new URL(`/invites/${encodeURIComponent(invitation.id)}`, publicBaseUrl);
      url.searchParams.set(
        "token",
        formatOpaqueToken(new ParsedOpaqueToken(invitation.id, secret(invitation))),
      );
      return url.toString();
    },
    verify: (token: ParsedOpaqueToken, invitation: Invitation) =>
      token.publicId === invitation.id &&
      verifyTokenSecret(token.secret, hashTokenSecret(secret(invitation))),
  };
};

export type OrganizationInvitationLinks = ReturnType<typeof makeOrganizationInvitationLinks>;
