"use client";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { beginLogin, pollLogin } from "@/app/(account)/auth/actions";
import { AccountInput, AccountField } from "@/components/ui/account/input";
import { AccountButton } from "@/components/ui/account/button";
import { FormFeedback } from "@/components/pages/account/form-feedback";
import type { AuthFormState } from "@/lib/densio/form-state";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [state, submit, pending] = useActionState(beginLogin, {});
  if (state.waiting) return <LoginWaiting waiting={state.waiting} returnTo={returnTo} />;
  return (
    <form action={submit} className="flex flex-col gap-7">
      <input type="hidden" name="returnTo" value={returnTo} />
      <AccountField label="Email address">
        <AccountInput
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          required
          disabled={pending}
        />
      </AccountField>
      <FormFeedback state={state} />
      <AccountButton type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Sending link…" : "Continue with email"}
      </AccountButton>
      <p className="text-center text-xs leading-[18px] text-muted-foreground">
        New to Densio? Your account will be created when you confirm your email.
      </p>
    </form>
  );
}
function LoginWaiting({
  waiting,
  returnTo,
}: {
  waiting: NonNullable<AuthFormState["waiting"]>;
  returnTo: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= new Date(waiting.expiresAt).getTime()) {
        setError("This link has expired. Request a new sign-in link.");
        return;
      }
      const result = await pollLogin(returnTo);
      if (!active) return;
      if (result.status === "confirmed") {
        router.replace(result.returnTo);
        router.refresh();
        return;
      }
      if (result.status === "error") {
        setError(result.error);
        return;
      }
      timer = setTimeout(poll, Math.max(1000, result.pollAfterSeconds * 1000));
    };
    timer = setTimeout(poll, Math.max(1000, waiting.pollAfterSeconds * 1000));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [waiting, router, attempt, returnTo]);
  return (
    <div className="flex flex-col items-center gap-7 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-border">
        <Mail className="size-5" />
      </div>
      <div className="text-sm leading-[21px]">
        <p className="font-medium">Check your inbox</p>
        <p className="mt-2 text-muted-foreground">
          We sent a sign-in link to{" "}
          <span className="break-all font-medium text-foreground">{waiting.email}</span>. Confirm it
          to continue here.
        </p>
      </div>
      {error ? (
        <div className="flex flex-col items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <AccountButton
            variant="outline"
            onClick={() => {
              setError(undefined);
              setAttempt((value) => value + 1);
            }}
          >
            Check again
          </AccountButton>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Waiting for confirmation…
        </p>
      )}
      <a
        href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
        className="text-sm font-medium underline underline-offset-4"
      >
        Use another email or request a new link
      </a>
    </div>
  );
}
