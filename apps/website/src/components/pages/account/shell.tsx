import Link from "next/link";
import type { ReactNode } from "react";
import type { OrganizationMembership } from "@densio/shared";
import { AccountBrand } from "./brand";
import { AccountMenu } from "./account-menu";
import { OrganizationSwitcher } from "./organization-switcher";
import { SettingsNavigation } from "./navigation";

export function AccountShell({
  organizations,
  organizationId,
  email,
  children,
}: {
  organizations: readonly OrganizationMembership[];
  organizationId: string;
  email: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-50 flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-background/80 px-5 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <AccountBrand />
          <span aria-hidden="true" className="text-xl font-light text-border">
            /
          </span>
          <OrganizationSwitcher organizations={organizations} organizationId={organizationId} />
        </div>
        <div className="flex shrink-0 items-center gap-5">
          <Link
            href="/docs/introduction"
            className="hidden text-sm leading-5 text-muted-foreground hover:text-foreground sm:block"
          >
            Documentation
          </Link>
          <AccountMenu email={email} organizationId={organizationId} />
        </div>
      </header>
      <main id="main-content" className="mx-auto w-full max-w-[816px] px-4 pt-20 pb-32 md:px-6">
        <div className="mb-8 flex flex-col gap-6">
          <h1 className="text-4xl leading-[45px] font-semibold tracking-[-0.03em]">Settings</h1>
          <SettingsNavigation organizationId={organizationId} />
        </div>
        <div className="flex flex-col gap-5">{children}</div>
      </main>
    </>
  );
}
