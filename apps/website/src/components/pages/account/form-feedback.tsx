import type { FormState } from "@/lib/densio/form-state";

export function FormFeedback({ state }: { state: FormState }) {
  if (!state.error && !state.success) return null;
  return (
    <div aria-live="polite" aria-atomic="true" className="text-sm leading-5">
      {state.error && (
        <p role="alert" className="text-destructive">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-muted-foreground">
          {state.success}
        </p>
      )}
    </div>
  );
}
