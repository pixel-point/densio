"use client";
import { useActionState, type ReactNode } from "react";
import { AccountButton } from "@/components/ui/account/button";
import { AccountCard, CardHeader, CardContent, CardFooter } from "@/components/ui/account/card";
import type { FormState } from "@/lib/densio/form-state";
import { FormFeedback } from "./form-feedback";

type Action = (state: FormState, form: FormData) => Promise<FormState>;
export function SettingsForm({
  action,
  title,
  description,
  children,
  submitLabel = "Save",
  disabled = false,
}: {
  action: Action;
  title: string;
  description: string;
  children: ReactNode;
  submitLabel?: string;
  disabled?: boolean;
}) {
  const [state, submit, pending] = useActionState(action, {});
  return (
    <form action={submit}>
      <AccountCard className="pb-4">
        <CardHeader title={title} description={description} />
        <CardContent>
          <fieldset disabled={pending || disabled} className="min-w-0">
            {children}
          </fieldset>
        </CardContent>
        {!disabled && (
          <CardFooter>
            <div className="mr-auto">
              <FormFeedback state={state} />
            </div>
            <AccountButton type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : submitLabel}
            </AccountButton>
          </CardFooter>
        )}
      </AccountCard>
    </form>
  );
}
export function ActionButton({
  action,
  label,
  variant = "outline",
  children,
}: {
  action: Action;
  label: string;
  variant?: "outline" | "destructive";
  children?: ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, {});
  return (
    <form action={submit} className="flex flex-wrap items-center gap-3">
      {children}
      <AccountButton type="submit" size="sm" variant={variant} disabled={pending}>
        {pending ? "Please wait…" : label}
      </AccountButton>
      <FormFeedback state={state} />
    </form>
  );
}
