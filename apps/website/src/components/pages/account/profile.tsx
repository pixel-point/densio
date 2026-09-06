import { setDefaultOrganization } from "@/app/(account)/app/actions";
import { logout } from "@/app/(account)/auth/actions";
import { getAccount, getOrganizations } from "@/lib/densio/account";
import { AccountCard, CardHeader, CardContent } from "@/components/ui/account/card";
import { AccountField, AccountInput } from "@/components/ui/account/input";
import { AccountSelect } from "@/components/ui/account/select";
import { SettingsForm, ActionButton } from "./action-form";
import { ApiError } from "./api-error";

export async function ProfileSettings({ organizationId }: { organizationId: string }) {
  const account = await getAccount(organizationId, "profile");
  if (!account.ok) return <ApiError error={account.error} />;
  const directory = await getOrganizations(account.session.token);
  if (!directory.ok) return <ApiError error={directory.error} />;
  return (
    <>
      <AccountCard>
        <CardHeader
          title="Email address"
          description="Your verified email is used to sign in and receive invitations."
        />
        <CardContent>
          <AccountField label="Email" className="max-w-[320px]">
            <AccountInput
              value={account.session.user.email}
              readOnly
              type="email"
              autoComplete="email"
            />
          </AccountField>
        </CardContent>
      </AccountCard>
      <SettingsForm
        action={setDefaultOrganization}
        title="Default organization"
        description="Used when the CLI or API does not specify an organization. Switching in the navigation only changes this browser."
      >
        <AccountField label="Organization" className="max-w-[320px]">
          <AccountSelect
            key={account.session.defaultOrganizationId}
            name="organizationId"
            label="Default organization"
            defaultValue={account.session.defaultOrganizationId}
            options={directory.data.organizations.map((item) => ({
              value: item.organization.organizationId,
              label: item.organization.name,
            }))}
          />
        </AccountField>
      </SettingsForm>
      <AccountCard>
        <CardHeader title="Session" description="Sign out of Densio on this browser." />
        <CardContent>
          <ActionButton action={logout} label="Sign out" />
        </CardContent>
      </AccountCard>
    </>
  );
}
