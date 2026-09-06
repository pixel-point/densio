"use client";
import { useActionState, type RefObject } from "react";
import { createOrganization } from "@/app/(account)/app/actions";
import { AccountDialog } from "@/components/ui/account/dialog";
import { AccountField, AccountInput } from "@/components/ui/account/input";
import { AccountButton } from "@/components/ui/account/button";
import { FormFeedback } from "./form-feedback";

export function CreateOrganization({
  open,
  onOpenChange,
  idempotencyKey,
  finalFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idempotencyKey: string;
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const [state, submit, pending] = useActionState(createOrganization, {});
  return (
    <AccountDialog
      finalFocus={finalFocus}
      open={open}
      onOpenChange={onOpenChange}
      title="Create organization"
      description="A separate workspace for your team, credits, and billing."
    >
      <form action={submit} className="flex flex-col gap-6">
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <AccountField label="Organization name">
          <AccountInput
            name="name"
            required
            maxLength={100}
            autoComplete="organization"
            placeholder="Acme Studio"
            disabled={pending}
          />
        </AccountField>
        <FormFeedback state={state} />
        <div className="flex justify-end">
          <AccountButton type="submit" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create organization"}
          </AccountButton>
        </div>
      </form>
    </AccountDialog>
  );
}
