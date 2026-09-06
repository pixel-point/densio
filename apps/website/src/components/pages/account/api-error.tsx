import Link from "next/link";
import type { ApiFailure } from "@/lib/densio/client";
import { AccountCard, CardHeader, CardContent } from "@/components/ui/account/card";
import { accountButtonVariants } from "@/components/ui/account/button-variants";

export function ApiError({ error }: { error: ApiFailure }) {
  return (
    <AccountCard>
      <CardHeader title={error.title} description={error.detail} />
      <CardContent>
        <Link href="/app" className={accountButtonVariants({ variant: "outline", size: "sm" })}>
          Return to your account
        </Link>
      </CardContent>
    </AccountCard>
  );
}
