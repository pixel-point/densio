"use client";
import { useActionState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { confirmLogin } from "@/app/(account)/auth/actions";
import { AccountButton } from "@/components/ui/account/button";
import { accountButtonVariants } from "@/components/ui/account/button-variants";
import { FormFeedback } from "@/components/pages/account/form-feedback";

export function ConfirmationForm({ token }: { token: string }) {
  const [state, submit, pending] = useActionState(confirmLogin, {});
  if (state.confirmed)
    return (
      <div className="flex flex-col items-center gap-7 text-center">
        <Check className="size-8" />
        <p className="text-sm leading-[21px] text-muted-foreground">
          Your email is confirmed. You can return to the browser or terminal where you started
          signing in.
        </p>
        {state.returnTo && (
          <Link href={state.returnTo} className={accountButtonVariants({ size: "lg" })}>
            Continue to Densio
          </Link>
        )}
      </div>
    );
  if (!token)
    return (
      <div className="text-center">
        <p role="alert" className="mb-7 text-sm text-muted-foreground">
          This sign-in link is incomplete. Request a new link to continue.
        </p>
        <Link href="/auth/login" className={accountButtonVariants({ size: "lg" })}>
          Request a new link
        </Link>
      </div>
    );
  return (
    <form action={submit} className="flex flex-col gap-7">
      <input type="hidden" name="token" value={token} />
      <FormFeedback state={state} />
      <AccountButton type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Confirming…" : "Confirm sign in"}
      </AccountButton>
      {state.error && (
        <Link
          href="/auth/login"
          className="text-center text-sm font-medium underline underline-offset-4"
        >
          Request a new link
        </Link>
      )}
    </form>
  );
}
