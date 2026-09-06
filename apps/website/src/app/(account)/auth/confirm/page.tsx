import { ConfirmationForm } from "@/components/pages/auth/confirmation-form";
export const metadata = { title: "Sign in" };
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const token = (await searchParams).token;
  return <ConfirmationForm token={typeof token === "string" && token.length <= 256 ? token : ""} />;
}
