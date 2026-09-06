"use client";
import { useActionState } from "react";
import { ArrowLeft } from "lucide-react";
import { beginLogin } from "@/app/(account)/auth/actions";
import { AccountInput, AccountField } from "@/components/ui/account/input";
import { AccountButton } from "@/components/ui/account/button";
import { FormFeedback } from "@/components/pages/account/form-feedback";
import type { AuthFormState } from "@/lib/densio/form-state";
import { useLoginPolling } from "./use-login-polling";
import { AuthFrame } from "./frame";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [state, submit, pending] = useActionState(beginLogin, {});
  if (state.waiting) return <LoginWaiting waiting={state.waiting} returnTo={returnTo} />;
  return (
    <AuthFrame title="Log in to Densio">
      <form action={submit} className="flex flex-col gap-7">
        <input type="hidden" name="returnTo" value={returnTo} />
        <AccountField label="Email" className="gap-1.5 [&_label]:text-foreground/80">
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
        <p className="text-center text-sm leading-5 text-muted-foreground">
          New to Densio? Your account will be created when you confirm your email.
        </p>
      </form>
    </AuthFrame>
  );
}

function LoginWaiting({
  waiting,
  returnTo,
}: {
  waiting: NonNullable<AuthFormState["waiting"]>;
  returnTo: string;
}) {
  const { error, retry } = useLoginPolling({ ...waiting, returnTo });
  return (
    <AuthFrame
      title="Check your email"
      description={
        <>
          We emailed a secure login link to{" "}
          <span className="break-all text-primary">{waiting.email}</span>.
          <br /> Open your inbox and click the link to continue.
        </>
      }
    >
      <div>
        <div className="mt-3 mb-14 h-px w-full bg-border" />
        {error ? (
          <div className="mb-7 flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <AccountButton variant="outline" onClick={retry}>
              Check again
            </AccountButton>
          </div>
        ) : (
          <p role="status" className="sr-only">
            Waiting for confirmation…
          </p>
        )}
        <a
          href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="inline-flex w-fit items-center gap-1.5 rounded text-sm leading-5 font-medium tracking-tight text-foreground transition-colors hover:text-foreground/80 [&_svg]:transition-transform [&_svg]:duration-300 motion-safe:hover:[&_svg]:-translate-x-0.5"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to Login
        </a>
      </div>
    </AuthFrame>
  );
}
