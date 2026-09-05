import { Effect } from "effect";
import { parseOpaqueToken } from "../auth/opaque-token.ts";
import type { Database } from "../database/database.ts";
import {
  acceptOrganizationInvitationLink,
  inspectOrganizationInvitationLink,
} from "../database/organization-invitation-link-repository.ts";
import { organizationFailure } from "./organization-errors.ts";
import type { OrganizationInvitationLinks } from "./organization-invitation-link.ts";
import { organizationStorage } from "./organization-service.ts";

export const makeOrganizationInvitationLinkService = (
  database: Database,
  links: OrganizationInvitationLinks,
) => ({
  inspect: Effect.fn("OrganizationInvitationLink.inspect")(function* (input: {
    token: string;
    now: number;
  }) {
    const token = yield* parseInvitationToken(input.token);
    const record = yield* organizationStorage("inspect-invitation-link", () =>
      inspectOrganizationInvitationLink(database.db, links, token, input.now),
    );
    return {
      name: record.organization.name,
      email: record.invitation.email,
      role: record.invitation.role,
      accepted: record.invitation.state === "accepted",
    };
  }),
  accept: Effect.fn("OrganizationInvitationLink.accept")(function* (input: {
    token: string;
    now: number;
    correlationId: string;
  }) {
    const token = yield* parseInvitationToken(input.token);
    return yield* organizationStorage("accept-invitation-link", () =>
      acceptOrganizationInvitationLink(database, links, { ...input, token }),
    );
  }),
});

export type OrganizationInvitationLinkService = ReturnType<
  typeof makeOrganizationInvitationLinkService
>;

const parseInvitationToken = Effect.fn("OrganizationInvitationLink.parseToken")((token: string) =>
  parseOpaqueToken(token).pipe(
    Effect.mapError(() =>
      organizationFailure(
        "ORGANIZATION_INVITATION_NOT_FOUND",
        "This invitation link is invalid. Ask the sender for a new invitation.",
      ),
    ),
  ),
);
