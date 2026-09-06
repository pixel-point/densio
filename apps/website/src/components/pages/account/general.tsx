import { renameOrganization } from "@/app/(account)/app/actions";
import { getAccount } from "@/lib/densio/account";
import { AccountCard, CardHeader, CardContent } from "@/components/ui/account/card";
import { AccountField, AccountInput } from "@/components/ui/account/input";
import { SettingsForm } from "./action-form";
import { ApiError } from "./api-error";

export async function GeneralSettings({ organizationId }: { organizationId: string }) {
  const account = await getAccount(organizationId);
  if (!account.ok) return <ApiError error={account.error} />;
  return (
    <>
      <SettingsForm
        action={renameOrganization.bind(null, organizationId)}
        title="Organization name"
        description="The name of your organization, visible to everyone on your team."
        disabled={account.membership.role === "member"}
      >
        <AccountField label="Name" className="max-w-[320px]">
          <AccountInput
            name="name"
            defaultValue={account.organization.name}
            required
            maxLength={100}
            autoComplete="organization"
          />
        </AccountField>
      </SettingsForm>
      <AccountCard>
        <CardHeader
          title="Organization details"
          description="Use this ID when selecting an organization in the Densio CLI or API."
        />
        <CardContent>
          <dl className="flex flex-col gap-4 text-sm leading-5">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Organization ID</dt>
              <dd className="select-all break-all">{account.organization.organizationId}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Your role</dt>
              <dd className="capitalize">{account.membership.role}</dd>
            </div>
          </dl>
        </CardContent>
      </AccountCard>
    </>
  );
}
