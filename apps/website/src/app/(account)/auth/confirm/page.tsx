import { AuthFrame } from "@/components/pages/auth/frame";
import { ConfirmationForm } from "@/components/pages/auth/confirmation-form";
export const metadata = { title: "Confirm sign in" };
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const token = (await searchParams).token;
  return (
    <AuthFrame
      title="Confirm your sign in"
      description="Continue if you requested this sign-in link."
    >
      <ConfirmationForm token={typeof token === "string" && token.length <= 256 ? token : ""} />
    </AuthFrame>
  );
}
