import { ProfileSettings } from "@/components/pages/account/profile";
export const metadata = { title: "Profile" };
export default async function Page({ params }: { params: Promise<{ organizationId: string }> }) {
  return <ProfileSettings organizationId={(await params).organizationId} />;
}
