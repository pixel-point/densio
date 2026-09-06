import { redirect } from "next/navigation";
import { getSession } from "@/lib/densio/account";
import { safeReturnTo } from "@/lib/densio/navigation";
import { AuthFrame } from "@/components/pages/auth/frame";
import { LoginForm } from "@/components/pages/auth/login-form";
export const metadata = { title: "Sign in" };
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const returnTo = safeReturnTo((await searchParams).returnTo);
  const session = await getSession();
  if (session?.ok) redirect(returnTo);
  return (
    <AuthFrame
      title="Welcome to Densio"
      description="Sign in or create an account with your email."
    >
      <LoginForm returnTo={returnTo} />
    </AuthFrame>
  );
}
