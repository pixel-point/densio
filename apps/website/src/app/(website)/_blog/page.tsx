import { Metadata } from "next";
import config from "@/configs/website-config";
import { Rss } from "lucide-react";

import { getCategories, getFeaturedPost, getPaginatedPosts, getTotalPages } from "@/lib/blog/posts";
import { getMetadata } from "@/lib/get-metadata";
import { Link } from "@/components/ui/link";
import SearchBar from "@/components/ui/search-bar";
import { Separator } from "@/components/ui/separator";
import CategoriesList from "@/components/pages/blog/categories-list";
import FeaturedPost from "@/components/pages/blog/featured-posts--grid";
import Hero from "@/components/pages/blog/hero--blog";
import Pagination from "@/components/pages/blog/pagination";
import PostsList from "@/components/pages/blog/posts-lists--column-authors-bottom";

export default async function BlogPage() {
  const currentPage = 1;

  const posts = await getPaginatedPosts(currentPage, {
    nonFeaturedOnly: true,
  });
  const totalPages = await getTotalPages();
  const categories = await getCategories();
  const featuredPosts = await getFeaturedPost();

  if (totalPages === 0) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col px-5 pt-10 pb-24 md:px-8 md:pt-16 md:pb-28 lg:pt-24 lg:pb-32 xl:pb-48">
        <Hero
          title="Ideas. Trends. Innovation. Blog."
          titleTag="h1"
          description="Explore the latest in UI/UX, design trends, and development insights. Stay ahead with expert tips and industry news!"
        />
        <p className="mt-10 text-lg tracking-tight text-muted-foreground md:mt-12 lg:mt-14">
          No posts yet
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col px-5 pt-10 pb-24 md:px-8 md:pt-16 md:pb-28 lg:pt-24 lg:pb-32 xl:pb-48">
      <Hero
        title="Ideas. Trends. Innovation. Blog."
        titleTag="h1"
        description="Explore the latest in UI/UX, design trends, and development insights. Stay ahead with expert tips and industry news!"
      />
      <div className="mt-10 flex flex-col gap-8 md:mt-12 md:flex-row md:items-center md:justify-between lg:mt-14">
        <CategoriesList
          categories={[
            {
              title: "All posts",
              url: "/blog",
              slug: { current: "" },
            },
            ...categories,
          ]}
        />
        <div className="hidden shrink-0 items-center justify-end gap-x-5 border-border md:flex lg:gap-x-6">
          <Link
            className="hidden whitespace-nowrap md:inline-flex [&_svg]:size-5"
            href="/blog/rss.xml"
            size="sm"
            variant="foreground"
          >
            <Rss size={20} />
            RSS
          </Link>
          <SearchBar className="hidden w-40 lg:inline-flex lg:w-56" placeholder="Search..." />
        </div>
      </div>
      {featuredPosts && featuredPosts.length > 0 && (
        <>
          <Separator className="mt-8 hidden sm:block lg:mt-9" />
          <FeaturedPost className="mt-8 mb-12 lg:mt-9 lg:mb-14 xl:mt-10" posts={featuredPosts} />
          <Separator className="mb-12 hidden sm:block lg:mb-14" />
        </>
      )}
      <PostsList title="All posts" posts={posts} />
      {totalPages > 1 && (
        <Pagination
          className="mt-14 w-full md:mt-20 lg:ml-64 lg:w-fit"
          currentPage={currentPage}
          pageCount={totalPages}
        />
      )}
    </main>
  );
}

export const metadata: Metadata = getMetadata({
  title: `Blog | densio | ${config.projectName}`,
  description: "Read the latest articles, news, and reviews on our blog",
  pathname: "/blog",
  imagePath: "/blog/opengraph-image",
});
