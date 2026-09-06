import { ConfirmationResult } from "@/components/pages/auth/confirmation-result";

export const metadata = { title: "Sign in" };

export default async function ConfirmationResultPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status } = await searchParams;
  return <ConfirmationResult status={typeof status === "string" ? status : undefined} />;
}
