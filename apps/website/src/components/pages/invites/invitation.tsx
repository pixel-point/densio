import { OrganizationInvitationLinkResponseSchema } from "@densio/shared";
import { densioApi } from "@/lib/densio/api";
import { AccountBrand } from "@/components/pages/account/brand";
import { AccountAvatar } from "@/components/ui/account/avatar";
import { InvitationAcceptance } from "./invitation-acceptance";

export async function Invitation({ invitationId, token }: { invitationId: string; token: string }) {
  const invitation = token
    ? await densioApi()(
        `/v1/organization-invitations/link?token=${encodeURIComponent(token)}`,
        OrganizationInvitationLinkResponseSchema,
      )
    : null;
  const valid = invitation?.ok && invitation.data.invitationId === invitationId;
  return (
    <main className="flex min-h-svh flex-1 flex-col">
      <div className="flex justify-center px-4 py-8">
        <AccountBrand />
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pt-8 pb-28">
        <div className="w-full max-w-[390px] text-center">
          {valid ? (
            <>
              <div className="flex justify-center">
                <AccountAvatar
                  name={invitation.data.name}
                  className="size-16 rounded-xl text-2xl"
                />
              </div>
              <h1 className="mt-7 text-xl leading-7 font-medium tracking-normal">
                Join {invitation.data.name}
              </h1>
              <p className="mt-2.5 text-sm leading-5 font-medium text-muted-foreground">
                You’ve been invited as {invitation.data.role === "admin" ? "an admin" : "a member"}{" "}
                using <span className="break-all text-foreground">{invitation.data.email}</span>.
              </p>
              <InvitationAcceptance token={token} invitation={invitation.data} />
            </>
          ) : (
            <>
              <h1 className="text-xl leading-7 font-medium">Invitation unavailable</h1>
              <p role="alert" className="mt-2.5 text-sm leading-5 text-muted-foreground">
                {invitation && !invitation.ok
                  ? invitation.error.detail
                  : "This invitation link is incomplete or invalid. Ask your team for a new invitation."}
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
