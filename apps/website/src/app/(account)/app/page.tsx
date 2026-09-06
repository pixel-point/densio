import { redirect } from "next/navigation";
import { requireSession, getOrganizations } from "@/lib/densio/account";
import { cookieNames, readCookie } from "@/lib/densio/cookies";
import { accountPath } from "@/lib/densio/navigation";
import { ApiError } from "@/components/pages/account/api-error";

export default async function AccountPage() {
  const session = await requireSession();
  if (!session.ok)
    return (
      <main className="mx-auto w-full max-w-[816px] px-6 py-20">
        <ApiError error={session.error} />
      </main>
    );
  const directory = await getOrganizations(session.token);
  if (!directory.ok)
    return (
      <main className="mx-auto w-full max-w-[816px] px-6 py-20">
        <ApiError error={directory.error} />
      </main>
    );
  const remembered = await readCookie(cookieNames.organization);
  const available = directory.data.organizations.map((item) => item.organization.organizationId);
  const selected =
    available.find((id) => id === remembered) ??
    available.find((id) => id === session.defaultOrganizationId) ??
    available[0];
  if (!selected)
    return (
      <main className="mx-auto w-full max-w-[816px] px-6 py-20">
        <ApiError
          error={{
            code: "NO_ORGANIZATIONS",
            status: 404,
            title: "No active organizations",
            detail:
              "You no longer belong to an active organization. Ask your team for a new invitation.",
            retryable: false,
          }}
        />
      </main>
    );
  redirect(accountPath(selected));
}
