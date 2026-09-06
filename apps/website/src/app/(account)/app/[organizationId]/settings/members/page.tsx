import { MembersSettings } from "@/components/pages/account/members";
export const metadata = { title: "Members" };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  return (
    <MembersSettings
      organizationId={(await params).organizationId}
      query={{
        membersCursor: typeof query.membersCursor === "string" ? query.membersCursor : undefined,
        invitationsCursor:
          typeof query.invitationsCursor === "string" ? query.invitationsCursor : undefined,
      }}
    />
  );
}
