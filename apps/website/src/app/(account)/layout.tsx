import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Your account · Densio", template: "%s · Densio" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";
export default function AccountLayout({ children }: { children: ReactNode }) {
  return <div className="account-theme flex min-h-svh flex-1 flex-col">{children}</div>;
}
