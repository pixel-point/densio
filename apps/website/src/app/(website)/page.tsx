import { Metadata } from "next";
import config from "@/configs/website-config";

import { getMetadata } from "@/lib/get-metadata";
import { Hero } from "@/components/pages/home/hero";

export const metadata: Metadata = getMetadata({
  title: config.projectName,
  description: "Agent-first video optimization.",
  pathname: "/",
});

export default function Home() {
  return (
    <main>
      <Hero />
    </main>
  );
}
