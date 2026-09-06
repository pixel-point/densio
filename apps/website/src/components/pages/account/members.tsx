import Link from "next/link";
import {
  OrganizationMembersResponseSchema,
  OrganizationInvitationsResponseSchema,
  type OrganizationInvitation,
  type OrganizationRole,
} from "@densio/shared";
import { getAccount } from "@/lib/densio/account";
import { densioApi } from "@/lib/densio/api";
import { organizationApiPath } from "@/lib/densio/mutations";
import { accountPath } from "@/lib/densio/navigation";
import { revokeInvitation } from "@/app/(account)/app/member-actions";
import { AccountCard, CardHeader, CardContent } from "@/components/ui/account/card";
import { AccountAvatar } from "@/components/ui/account/avatar";
import { ApiError } from "./api-error";
import { ActionButton } from "./action-form";
import { InviteForm } from "./invite-form";

export type MemberQuery = { membersCursor?: string; invitationsCursor?: string };
export async function MembersSettings({
  organizationId,
  query,
}: {
  organizationId: string;
  query: MemberQuery;
}) {
  const account = await getAccount(organizationId, "members");
  if (!account.ok) return <ApiError error={account.error} />;
  const members = await densioApi()(
    organizationApiPath(organizationId, `/members?limit=25${cursorQuery(query.membersCursor)}`),
    OrganizationMembersResponseSchema,
    { token: account.session.token },
  );
  const canInvite = account.membership.role !== "member";
  return (
    <>
      {canInvite && (
        <InviteForm organizationId={organizationId} owner={account.membership.role === "owner"} />
      )}
      {members.ok ? (
        <AccountCard>
          <CardHeader title="Members" description="Everyone with access to this organization." />
          <CardContent>
            <ul className="divide-y divide-border">
              {members.data.members.map((member) => (
                <li
                  key={member.membershipId}
                  className="flex items-center gap-3 py-4 first:pt-0 last:pb-0"
                >
                  <AccountAvatar name={member.email} className="size-10 rounded-full text-sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm leading-5 font-medium tracking-tight">
                      {member.email}
                      {member.userId === account.session.user.id && (
                        <span className="font-normal text-muted-foreground"> (you)</span>
                      )}
                    </p>
                  </div>
                  <span className="text-sm leading-5 text-muted-foreground capitalize">
                    {member.role}
                  </span>
                </li>
              ))}
            </ul>
            <DirectoryPagination
              organizationId={organizationId}
              query={query}
              field="membersCursor"
              nextCursor={members.data.nextCursor}
            />
          </CardContent>
        </AccountCard>
      ) : (
        <ApiError error={members.error} />
      )}
      {canInvite && (
        <InvitationList
          organizationId={organizationId}
          token={account.session.token}
          role={account.membership.role}
          query={query}
        />
      )}
    </>
  );
}
async function InvitationList({
  organizationId,
  token,
  role,
  query,
}: {
  organizationId: string;
  token: string;
  role: OrganizationRole;
  query: MemberQuery;
}) {
  const invitations = await densioApi()(
    organizationApiPath(
      organizationId,
      `/invitations?state=pending&limit=25${cursorQuery(query.invitationsCursor)}`,
    ),
    OrganizationInvitationsResponseSchema,
    { token },
  );
  if (!invitations.ok) return <ApiError error={invitations.error} />;
  return (
    <AccountCard>
      <CardHeader title="Pending invitations" description="Invitations waiting to be accepted." />
      <CardContent>
        {invitations.data.invitations.length === 0 ? (
          <p className="text-sm leading-5 text-muted-foreground">No pending invitations.</p>
        ) : (
          <ul className="divide-y divide-border">
            {invitations.data.invitations.map((invitation) => (
              <InvitationRow
                key={invitation.invitationId}
                invitation={invitation}
                canRevoke={role === "owner" || invitation.role === "member"}
              />
            ))}
          </ul>
        )}
        <DirectoryPagination
          organizationId={organizationId}
          query={query}
          field="invitationsCursor"
          nextCursor={invitations.data.nextCursor}
        />
      </CardContent>
    </AccountCard>
  );
}
function InvitationRow({
  invitation,
  canRevoke,
}: {
  invitation: OrganizationInvitation;
  canRevoke: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
      <AccountAvatar name={invitation.email} className="size-10 rounded-full text-sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-5 font-medium tracking-tight">{invitation.email}</p>
        <p className="text-xs leading-4 text-muted-foreground capitalize">
          {invitation.role} · Expires{" "}
          {new Date(invitation.expiresAt).toLocaleDateString("en", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })}
        </p>
      </div>
      {canRevoke && (
        <ActionButton
          action={revokeInvitation.bind(null, invitation.organizationId, invitation.invitationId)}
          label="Revoke"
        />
      )}
    </li>
  );
}
function DirectoryPagination({
  organizationId,
  query,
  field,
  nextCursor,
}: {
  organizationId: string;
  query: MemberQuery;
  field: keyof MemberQuery;
  nextCursor?: string;
}) {
  if (!query[field] && !nextCursor) return null;
  const params = new URLSearchParams(
    Object.entries(query).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  params.delete(field);
  const first = `${accountPath(organizationId, "members")}?${params}`;
  if (nextCursor) params.set(field, nextCursor);
  return (
    <nav
      aria-label={field === "membersCursor" ? "Members pages" : "Invitations pages"}
      className="mt-5 flex justify-between gap-4 text-sm font-medium"
    >
      {query[field] ? <Link href={first}>Back to first page</Link> : <span />}
      {nextCursor && (
        <Link href={`${accountPath(organizationId, "members")}?${params}`}>Next page →</Link>
      )}
    </nav>
  );
}
const cursorQuery = (cursor?: string) => (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
