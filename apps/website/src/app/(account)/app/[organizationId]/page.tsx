import { redirect } from "next/navigation";
import { accountPath } from "@/lib/densio/navigation";
export default async function OrganizationPage({
  params,
}: {
  params: Promise<{ organizationId: string }>;
}) {
  redirect(accountPath((await params).organizationId));
}
