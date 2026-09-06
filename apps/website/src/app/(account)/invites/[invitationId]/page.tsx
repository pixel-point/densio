import { Invitation } from "@/components/pages/invites/invitation";
export const metadata = { title: "Team invitation" };
export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ invitationId: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const token = (await searchParams).token;
  return (
    <Invitation
      invitationId={(await params).invitationId}
      token={typeof token === "string" && token.length <= 256 ? token : ""}
    />
  );
}
