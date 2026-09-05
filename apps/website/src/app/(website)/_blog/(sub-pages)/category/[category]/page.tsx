import { Metadata } from "next";
import { notFound } from "next/navigation";
import config from "@/configs/website-config";

import { ICategory } from "@/types/blog";
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
  }>;
}

export async function generateStaticParams() {
  const categories = await getCategories();

  return categories.map((category: ICategory) => ({
    category: category.slug.current,
  }));
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { category } = await params;
  const currentPage = 1;

  const posts = await getPaginatedPostsByCategory(category, currentPage);
  const totalPages = await getTotalPagesByCategory(category);
  const categoryData = await getCategoryBySlug(category);

  if (totalPages === 0 || !categoryData) {
    notFound();
  }

  return (
    <main>
      <h1 className="sr-only">Blog - {categoryData.title}</h1>
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
  const { category } = await params;
  const categoryData = await getCategoryBySlug(category);

  if (!categoryData) {
    return {};
  }

  return getMetadata({
    title: `Blog: ${categoryData.title} | ${config.projectName}`,
    description: `${categoryData.title} Read the latest articles, news, and reviews on our blog`,
    pathname: `/blog/category/${category}`,
    imagePath: "/blog/opengraph-image",
  });
}
