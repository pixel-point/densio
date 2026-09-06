import { Metadata } from "next";
import { redirect } from "next/navigation";
import config from "@/configs/website-config";

import { getMetadata } from "@/lib/get-metadata";
import { getSession } from "@/lib/densio/account";
import { Hero } from "@/components/pages/home/hero";

export const metadata: Metadata = getMetadata({
  title: config.projectName,
  description: "Agent-first video optimization.",
  pathname: "/",
});

export default async function Home() {
  const session = await getSession();
  if (session?.ok) redirect("/app");
  return (
    <main>
      <Hero />
    </main>
  );
}
