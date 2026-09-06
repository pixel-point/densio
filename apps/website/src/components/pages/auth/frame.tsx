import type { ReactNode } from "react";
import { AccountBrand } from "@/components/pages/account/brand";

export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-svh flex-1 items-center justify-center px-4 py-8">
      <div className="flex w-full max-w-[448px] flex-col gap-11">
        <div className="flex flex-col gap-5">
          <AccountBrand size="auth" />
          <h1 className="text-3xl leading-9 font-bold tracking-normal">{title}</h1>
          {description && (
            <p className="text-base leading-6 font-medium text-balance text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {children}
      </div>
    </main>
  );
}
