"use client";
import { AccountButton } from "@/components/ui/account/button";
export default function AccountError({ reset }: { reset: () => void }) {
  return (
    <main className="account-theme mx-auto w-full max-w-[448px] px-4 py-20 text-center">
      <h1 className="text-xl leading-7 font-medium">This page could not load</h1>
      <p className="my-6 text-sm text-muted-foreground">
        Please try again. Your account data is stored safely with Densio.
      </p>
      <AccountButton onClick={reset}>Try again</AccountButton>
    </main>
  );
}
