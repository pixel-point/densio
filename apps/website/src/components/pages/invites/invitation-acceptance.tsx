"use client";
import { useActionState } from "react";
import Link from "next/link";
import type { OrganizationInvitationLinkResponse } from "@densio/shared";
import { acceptInvitation } from "@/app/(account)/invites/actions";
import { accountPath } from "@/lib/densio/navigation";
import { AccountButton } from "@/components/ui/account/button";
import { accountButtonVariants } from "@/components/ui/account/button-variants";
import { FormFeedback } from "@/components/pages/account/form-feedback";

export function InvitationAcceptance({
  token,
  invitation,
}: {
  token: string;
  invitation: OrganizationInvitationLinkResponse;
}) {
  const [state, submit, pending] = useActionState(acceptInvitation.bind(null, token), {});
  const accepted = invitation.accepted || Boolean(state.success);
  return (
    <div className="mx-auto mt-7 flex w-full max-w-[320px] flex-col gap-5">
      {accepted ? (
        <>
          <p role="status" className="text-sm leading-5">
            You’re a member of {invitation.name}.
          </p>
          <Link
            href={`/auth/login?returnTo=${encodeURIComponent(accountPath(invitation.organizationId))}`}
            className={accountButtonVariants({ size: "lg" })}
          >
            Continue to organization
          </Link>
          <p className="text-xs leading-[18px] text-muted-foreground">
            Sign in with {invitation.email} to open this organization.
          </p>
        </>
      ) : (
        <form action={submit} className="flex flex-col gap-5">
          <AccountButton type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? "Joining…" : "Accept invitation"}
          </AccountButton>
          <FormFeedback state={state} />
        </form>
      )}
    </div>
  );
}
