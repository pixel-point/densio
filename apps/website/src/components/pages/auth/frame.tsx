import type { ReactNode } from "react";
import { AccountBrand } from "@/components/pages/account/brand";

export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-[448px]">
        <div className="mb-11 flex flex-col items-center gap-5 text-center">
          <AccountBrand />
          <div>
            <h1 className="text-3xl leading-9 font-bold tracking-normal">{title}</h1>
            <p className="mt-3 text-sm leading-[21px] text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
