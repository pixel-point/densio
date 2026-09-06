import { BillingSettings } from "@/components/pages/account/billing";
export const metadata = { title: "Billing" };
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  return <BillingSettings organizationId={(await params).organizationId} />;
}
