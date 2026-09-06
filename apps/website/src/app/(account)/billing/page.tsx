import { BillingReturn } from "@/components/pages/billing/return";
export const metadata = { title: "Billing" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string | string[] }>;
}) {
  const organizationId = (await searchParams).organizationId;
  return (
    <BillingReturn
      kind="portal"
      organizationId={typeof organizationId === "string" ? organizationId : undefined}
    />
  );
}
