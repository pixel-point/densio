import Link from "next/link";
import { AuthFrame } from "@/components/pages/auth/frame";
import { accountButtonVariants } from "@/components/ui/account/button-variants";
import { accountPath } from "@/lib/densio/navigation";

const copy = {
  success: {
    title: "Checkout complete",
    description: "Thank you. Your plan and credits will update once the payment is confirmed.",
  },
  canceled: {
    title: "Checkout canceled",
    description:
      "Checkout was canceled. You can return to your account or try again whenever you’re ready.",
  },
  portal: {
    title: "Back to Densio",
    description: "You can check your current plan and billing details in your account.",
  },
};
export function BillingReturn({
  kind,
  organizationId,
}: {
  kind: keyof typeof copy;
  organizationId?: string;
}) {
  const returnTo =
    organizationId && /^[A-Za-z0-9_-]+$/.test(organizationId)
      ? accountPath(organizationId, "billing")
      : "/app";
  return (
    <AuthFrame {...copy[kind]}>
      <div className="flex flex-col items-start gap-7">
        <Link href={returnTo} className={accountButtonVariants({ size: "lg" })}>
          Go to billing
        </Link>
        <p className="text-sm leading-[21px] text-muted-foreground">
          Started from the terminal? You can return there and check billing status. You may need to
          sign in to view it in this browser.
        </p>
      </div>
    </AuthFrame>
  );
}
