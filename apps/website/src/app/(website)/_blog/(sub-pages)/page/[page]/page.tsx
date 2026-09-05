import { Metadata } from "next";
import { notFound } from "next/navigation";
import config from "@/configs/website-config";

import { getPaginatedPosts, getTotalPages } from "@/lib/blog/posts";
import { getMetadata } from "@/lib/get-metadata";
import Pagination from "@/components/pages/blog/pagination";
import PostsList from "@/components/pages/blog/posts-lists--column-authors-bottom";

interface BlogPageProps {
  params: Promise<{
    page: string;
  }>;
}

export default async function BlogPage({ params }: BlogPageProps) {
  const { page } = await params;
  const currentPage = parseInt(page, 10);

  if (isNaN(currentPage) || currentPage < 1) {
    notFound();
  }

  if (currentPage === 1) {
    notFound();
  }

  const posts = await getPaginatedPosts(currentPage, {
    nonFeaturedOnly: true,
  });
  const totalPages = await getTotalPages();

  if (totalPages === 0 || totalPages < currentPage) {
    notFound();
  }

  return (
    <>
      <main>
        <h1 className="sr-only">Blog - page {currentPage}</h1>
        <PostsList title="All posts" posts={posts} />
        {totalPages > 1 && (
          <Pagination
            className="mt-14 w-full md:mt-20 lg:ml-64 lg:w-fit"
            currentPage={currentPage}
            pageCount={totalPages}
          />
        )}
      </main>
    </>
  );
}

export async function generateStaticParams() {
  const totalPages = await getTotalPages();
  const params = [];

  for (let page = 2; page <= totalPages; page++) {
    params.push({
      page: page.toString(),
    });
  }

  return params;
}

export async function generateMetadata({ params }: BlogPageProps): Promise<Metadata> {
  const { page: pageNumber } = await params;
  const page = parseInt(pageNumber, 10);

  return getMetadata({
    title: `Blog${page > 1 ? ` - Page ${page}` : ""} | ${config.projectName}`,
    description: `Read the latest articles, news, and reviews on our blog ${page > 1 ? `Page ${page}` : ""}`,
    pathname: `/blog/page/${page}`,
    imagePath: "/blog/opengraph-image",
  });
}
