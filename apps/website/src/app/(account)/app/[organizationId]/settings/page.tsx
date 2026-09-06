import { GeneralSettings } from "@/components/pages/account/general";
export const metadata = { title: "General settings" };
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  return <GeneralSettings organizationId={(await params).organizationId} />;
}
