import { Metadata } from "next";
import { notFound } from "next/navigation";

import { getMetadata } from "@/lib/get-metadata";
import { getLegalPageBySlug } from "@/lib/legal/pages";
import { getFormattedDate } from "@/lib/utils";
import LegalPage from "@/components/pages/legal/legal-page--centered";

const category = "";
const fullSlug = (slug: string) => [category, slug].filter(Boolean).join("/");

export default async function PrivacyPolicyPage() {
  const page = await getLegalPageBySlug(fullSlug("privacy-policy"));

  if (!page) {
    notFound();
  }

  const { title, updatedAt, content, tableOfContents } = page;

  const formattedDate = getFormattedDate(updatedAt, "long");

  return (
    <LegalPage
      title={title}
      updatedAt={updatedAt}
      formattedDate={formattedDate}
      content={content}
      tableOfContents={tableOfContents}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const page = await getLegalPageBySlug(fullSlug("privacy-policy"));

  if (!page) {
    return {};
  }

  const { seo } = page;

  return getMetadata({
    title: seo.title,
    description: seo.description,
    pathname: "/privacy-policy",
    imagePath: seo.socialImage,
    noIndex: seo.noIndex,
  });
}
