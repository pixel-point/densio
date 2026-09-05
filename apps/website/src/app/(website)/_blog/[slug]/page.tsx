import { Metadata } from "next";
import { notFound } from "next/navigation";
import config from "@/configs/website-config";

import { getAllPosts, getPostBySlug, getPostDataBySlug } from "@/lib/blog/posts";
import { getMetadata } from "@/lib/get-metadata";
import Post from "@/components/pages/blog/post/post";

export const dynamicParams = false;

interface BlogPostPageProps {
  params: Promise<{ slug: string }>;
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = await getPostBySlug(slug);

  if (!post) {
    notFound();
  }

  const siteUrl = process.env.NEXT_PUBLIC_DEFAULT_SITE_URL || "";
  const postUrl = `${siteUrl}/blog/${post.slug.current}`;
  const authors = (post.authors || []).map((author) => ({
    "@type": "Person",
    name: author.name,
    ...(author.photo ? { image: author.photo } : {}),
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.seo?.title || post.title,
    description: post.seo?.description || "",
    datePublished: post.publishedAt,

    url: postUrl,
    image: post.seo?.socialImage || `${siteUrl}/blog/${post.slug.current}/opengraph-image`,
    author: authors.length > 0 ? authors : [{ "@type": "Person", name: "Unknown" }],
  };

  return (
    <main className="pt-8 pb-24 md:pt-11 lg:pt-16 lg:pb-48">
      <Post post={post} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />
    </main>
  );
}

export async function generateStaticParams() {
  const posts = await getAllPosts();

  return posts.map((post) => ({
    slug: post.slug.current,
  }));
}

export async function generateMetadata({ params }: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostDataBySlug(slug);

  if (!post) {
    return {};
  }

  const { seo } = post;

  const metadata = getMetadata({
    title: `${seo.title} | ${config.projectName}`,
    description: seo.description,
    pathname: `/blog/${post.slug.current}`,
    imagePath: seo.socialImage,
    noIndex: seo.noIndex,
  });

  return metadata;
}
