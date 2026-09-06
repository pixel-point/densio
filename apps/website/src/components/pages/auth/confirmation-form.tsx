"use client";
import { startTransition, useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { confirmLogin } from "@/app/(account)/auth/actions";
import { AccountButton } from "@/components/ui/account/button";
import { accountButtonVariants } from "@/components/ui/account/button-variants";
import { AuthFrame } from "./frame";
import { useLoginPolling } from "./use-login-polling";

export function ConfirmationForm({ token }: { token: string }) {
  const [state, submit] = useActionState(confirmLogin, {});
  const started = useRef<string | undefined>(undefined);
  const { error: pollingError, retry } = useLoginPolling({
    enabled: Boolean(state.confirmed && state.returnTo),
    returnTo: state.returnTo ?? "/app",
  });
  useEffect(() => {
    if (!token || started.current === token) return;
    started.current = token;
    const form = new FormData();
    form.set("token", token);
    // Complete on browser navigation, without consuming links during server prefetches.
    startTransition(() => submit(form));
  }, [submit, token]);
  const error = !token
    ? "This sign-in link is incomplete. Request a new link to continue."
    : (state.error ?? pollingError);
  const confirmedElsewhere = state.confirmed && !state.returnTo;
  return (
    <AuthFrame
      title={
        error ? "Unable to sign in" : confirmedElsewhere ? "Sign-in confirmed" : "Signing you in"
      }
      description={error || confirmedElsewhere ? "" : "You'll be redirected automatically."}
    >
      {error ? (
        <div className="flex flex-col items-center gap-7 text-center">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {pollingError && <AccountButton onClick={retry}>Try again</AccountButton>}
          <Link href="/auth/login" className={accountButtonVariants({ size: "lg" })}>
            Request a new link
          </Link>
        </div>
      ) : confirmedElsewhere ? (
        <div className="flex flex-col items-center gap-7 text-center" role="status">
          <Check className="size-8" />
          <p className="text-sm leading-[21px] text-muted-foreground">
            You can return to the browser or terminal where you started signing in.
          </p>
        </div>
      ) : (
        <p role="status" className="text-center text-sm text-muted-foreground">
          Completing your sign-in…
        </p>
      )}
    </AuthFrame>
  );
}
