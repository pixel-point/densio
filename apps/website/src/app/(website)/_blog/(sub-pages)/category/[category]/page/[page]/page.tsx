import { Metadata } from "next";
import { notFound } from "next/navigation";
import config from "@/configs/website-config";

import {
  getCategories,
  getCategoryBySlug,
  getPaginatedPostsByCategory,
  getTotalPagesByCategory,
} from "@/lib/blog/posts";
import { getMetadata } from "@/lib/get-metadata";
import Pagination from "@/components/pages/blog/pagination";
import PostsList from "@/components/pages/blog/posts-lists--column-authors-bottom";

interface CategoryPageProps {
  params: Promise<{
    category: string;
    page: string;
  }>;
}

export async function generateStaticParams() {
  const cats = await getCategories();

  const counts = await Promise.all(cats.map((c) => getTotalPagesByCategory(c.slug.current)));

  const params: { category: string; page: string }[] = [];
  cats.forEach((c, i) => {
    const total = counts[i];
    for (let page = 2; page <= total; page++) {
      params.push({ category: c.slug.current, page: String(page) });
    }
  });

  return params;
}

export default async function CategoryPagePagination({ params }: CategoryPageProps) {
  const { category, page } = await params;
  const currentPage = parseInt(page, 10);

  if (isNaN(currentPage) || currentPage < 2) {
    notFound();
  }

  const posts = await getPaginatedPostsByCategory(category, currentPage, {
    nonFeaturedOnly: true,
  });
  const totalPages = await getTotalPagesByCategory(category);
  const categoryData = await getCategoryBySlug(category);

  if (totalPages === 0 || totalPages < currentPage || !categoryData) {
    notFound();
  }

  return (
    <main>
      <h1 className="sr-only">
        Blog - {categoryData.title} - page {page}
      </h1>
      <PostsList title={`Posts in ${categoryData.title}`} posts={posts} />
      {totalPages > 1 && (
        <Pagination
          className="mt-14 w-full md:mt-20 lg:ml-64 lg:w-fit"
          currentPage={currentPage}
          pageCount={totalPages}
          path={category}
        />
      )}
    </main>
  );
}

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { category, page: pageNumber } = await params;
  const page = parseInt(pageNumber, 10);
  const categoryData = await getCategoryBySlug(category);

  if (!categoryData) {
    return {};
  }

  return getMetadata({
    title: `Blog: ${categoryData.title} - page ${page} | ${config.projectName}`,
    description: `${categoryData.title} Read the latest articles, news, and reviews on our blog ${page > 1 ? `Page ${page}` : ""}`,
    pathname: `/blog/category/${category}/page/${page}`,
    imagePath: "/blog/opengraph-image",
  });
}
