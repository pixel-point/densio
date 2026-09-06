import Link from "next/link";
import { Check } from "lucide-react";
import { accountButtonVariants } from "@/components/ui/account/button-variants";
import { AuthFrame } from "./frame";

const errors: Record<string, string> = {
  expired: "This sign-in link has expired. Request a new link to continue.",
  used: "This sign-in link has already been used. Request a new link if you need to sign in again.",
  invalid: "This sign-in link is incomplete or invalid. Request a new link to continue.",
  unavailable: "We could not complete sign-in. Please request a new link and try again.",
};

export function ConfirmationResult({ status }: { status?: string }) {
  const confirmed = status === "confirmed";
  const error = status && Object.hasOwn(errors, status) ? errors[status] : errors.invalid;
  return (
    <AuthFrame title={confirmed ? "Sign-in confirmed" : "Unable to sign in"}>
      {confirmed ? (
        <div className="flex flex-col items-start gap-7" role="status">
          <Check className="size-8" aria-hidden="true" />
          <p className="text-sm leading-[21px] text-muted-foreground">
            You can return to the browser or terminal where you started signing in.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-7">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Link href="/auth/login" className={accountButtonVariants({ size: "lg" })}>
            Request a new link
          </Link>
        </div>
      )}
    </AuthFrame>
  );
}
