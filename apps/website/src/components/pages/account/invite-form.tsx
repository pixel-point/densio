"use client";
import { useActionState } from "react";
import { inviteMember } from "@/app/(account)/app/member-actions";
import { AccountCard, CardHeader, CardContent, CardFooter } from "@/components/ui/account/card";
import { AccountField, AccountInput } from "@/components/ui/account/input";
import { AccountSelect } from "@/components/ui/account/select";
import { AccountButton } from "@/components/ui/account/button";
import { FormFeedback } from "./form-feedback";

export function InviteForm({ organizationId, owner }: { organizationId: string; owner: boolean }) {
  const [state, submit, pending] = useActionState(inviteMember.bind(null, organizationId), {});
  const options = [
    { value: "member", label: "Member" },
    ...(owner ? [{ value: "admin", label: "Admin" }] : []),
  ];
  return (
    <form action={submit}>
      <AccountCard className="gap-8 pb-0">
        <CardHeader
          title="Invite members"
          description="Invite your teammates to collaborate in this organization."
        />
        <CardContent>
          <fieldset disabled={pending} className="flex flex-col gap-3 sm:flex-row">
            <AccountField label="Email address" className="flex-1">
              <AccountInput
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
              />
            </AccountField>
            <AccountField label="Role" className="sm:w-[320px]">
              <AccountSelect
                name="role"
                label="Invitation role"
                defaultValue="member"
                options={options}
                disabled={pending}
              />
            </AccountField>
          </fieldset>
        </CardContent>
        <CardFooter className="min-h-16 py-4">
          <div className="mr-auto">
            <FormFeedback state={state} />
          </div>
          <AccountButton type="submit" size="sm" disabled={pending}>
            {pending ? "Sending…" : "Send invitation"}
          </AccountButton>
        </CardFooter>
      </AccountCard>
    </form>
  );
}
