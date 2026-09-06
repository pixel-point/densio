import { randomUUID } from "node:crypto";
import { BillingStatusSchema, PAID_PLANS, PLAN_CATALOG, type BillingStatus } from "@densio/shared";
import { getAccount } from "@/lib/densio/account";
import { densioApi } from "@/lib/densio/api";
import { organizationApiPath } from "@/lib/densio/mutations";
import {
  updateBillingContact,
  openBillingPortal,
  checkoutPlan,
} from "@/app/(account)/app/billing-actions";
import { AccountCard, CardHeader, CardContent } from "@/components/ui/account/card";
import { AccountInput, AccountField } from "@/components/ui/account/input";
import { AccountSelect } from "@/components/ui/account/select";
import { SettingsForm, ActionButton } from "./action-form";
import { ApiError } from "./api-error";

export async function BillingSettings({ organizationId }: { organizationId: string }) {
  const account = await getAccount(organizationId, "billing");
  if (!account.ok) return <ApiError error={account.error} />;
  const status = await densioApi()(
    organizationApiPath(organizationId, "/billing/status"),
    BillingStatusSchema,
    { token: account.session.token },
  );
  if (!status.ok) return <ApiError error={status.error} />;
  const owner = account.membership.role === "owner";
  return (
    <>
      <PlanCard status={status.data} owner={owner} />
      <CreditsCard status={status.data} />
      <SettingsForm
        action={updateBillingContact.bind(null, organizationId)}
        title="Billing contact"
        description="Where invoices and billing updates for this organization are sent."
        disabled={!owner}
      >
        <AccountField
          key={status.data.billingEmail}
          label="Billing email"
          className="max-w-[320px]"
        >
          <AccountInput
            name="billingEmail"
            type="email"
            autoComplete="email"
            required
            defaultValue={status.data.billingEmail}
          />
        </AccountField>
      </SettingsForm>
      {owner && (
        <SettingsForm
          action={checkoutPlan.bind(null, organizationId)}
          title="Change plan"
          description="Review pricing and confirm your choice in secure checkout. Existing subscriptions are managed in the billing portal."
          submitLabel="Continue"
        >
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <AccountField label="Plan" className="max-w-[320px]">
            <AccountSelect
              name="plan"
              label="Choose a plan"
              defaultValue={status.data.plan === "free" ? "basic" : status.data.plan}
              options={PAID_PLANS.map((plan) => ({
                value: plan,
                label: `${capitalize(plan)} · ${formatNumber(PLAN_CATALOG[plan].monthlyCredits)} credits / month`,
              }))}
            />
          </AccountField>
        </SettingsForm>
      )}
    </>
  );
}
function PlanCard({ status, owner }: { status: BillingStatus; owner: boolean }) {
  return (
    <AccountCard>
      <CardHeader
        title="Current plan"
        description="Your plan and subscription belong to this organization."
      />
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-2xl leading-8 font-semibold tracking-tight">
            {capitalize(status.plan)}
          </p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {status.subscriptionStatus
              ? capitalize(status.subscriptionStatus.replaceAll("_", " "))
              : "No paid subscription"}
            {status.renewsAt ? ` · Renews ${formatDate(status.renewsAt)}` : ""}
          </p>
        </div>
        {owner && status.subscriptionStatus && (
          <ActionButton
            action={openBillingPortal.bind(null, status.organizationId)}
            label="Manage subscription"
          />
        )}
      </CardContent>
    </AccountCard>
  );
}
function CreditsCard({ status }: { status: BillingStatus }) {
  const entries = [
    { label: "Available", value: status.credits.available },
    { label: "Used", value: status.credits.used },
    { label: "Reserved", value: status.credits.reserved },
    { label: "Monthly allowance", value: status.credits.monthly },
  ];
  return (
    <AccountCard>
      <CardHeader
        title="Credits"
        description={`Your allowance resets ${formatDate(status.credits.resetsAt)}. Reserved credits are held for jobs in progress.`}
      />
      <CardContent>
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          {entries.map((entry) => (
            <div key={entry.label}>
              <dt className="text-sm leading-5 text-muted-foreground">{entry.label}</dt>
              <dd className="mt-2 text-2xl leading-8 font-semibold tracking-tight tabular-nums">
                {formatNumber(entry.value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </AccountCard>
  );
}
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const formatNumber = (value: number) =>
  new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value);
const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
