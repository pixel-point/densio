import type { ReactNode } from "react";
import { getAccount, getOrganizations, getSession } from "@/lib/densio/account";
import { AccountShell } from "@/components/pages/account/shell";
import { ApiError } from "@/components/pages/account/api-error";

export default async function OrganizationLayout({
  params,
  children,
}: {
  params: Promise<{ organizationId: string }>;
  children: ReactNode;
}) {
  const { organizationId } = await params;
  if ((await getSession()) === null) return children;
  const account = await getAccount(organizationId);
  if (!account.ok)
    return (
      <main className="mx-auto w-full max-w-[816px] px-6 py-20">
        <ApiError error={account.error} />
      </main>
    );
  const directory = await getOrganizations(account.session.token);
  if (!directory.ok)
    return (
      <main className="mx-auto w-full max-w-[816px] px-6 py-20">
        <ApiError error={directory.error} />
      </main>
    );
  return (
    <AccountShell
      organizations={directory.data.organizations}
      organizationId={organizationId}
      email={account.session.user.email}
    >
      {children}
    </AccountShell>
  );
}
