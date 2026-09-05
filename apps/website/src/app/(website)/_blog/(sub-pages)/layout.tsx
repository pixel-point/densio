import { ReactNode } from "react";
import { Rss } from "lucide-react";

import { getCategories } from "@/lib/blog/posts";
import { Link } from "@/components/ui/link";
import SearchBar from "@/components/ui/search-bar";
import { Separator } from "@/components/ui/separator";
import CategoriesList from "@/components/pages/blog/categories-list";
import Hero from "@/components/pages/blog/hero--blog";

export default async function BlogPagesLayout({ children }: { children: ReactNode }) {
  const categories = await getCategories();

  return (
    <div className="mx-auto flex max-w-4xl flex-col px-5 pt-10 pb-24 md:px-8 md:pt-16 md:pb-28 lg:pt-24 lg:pb-32 xl:pb-48">
      <Hero
        title="Ideas. Trends. Innovation. Blog."
        titleTag="p"
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
            href={"/blog/rss.xml"}
            size="sm"
            variant="foreground"
          >
            <Rss size={20} />
            RSS
          </Link>
          <SearchBar className="hidden w-40 lg:inline-flex lg:w-56" placeholder="Search..." />
        </div>
      </div>
      <Separator className="my-6 md:mt-9 md:mb-14 lg:mb-14" />
      {children}
    </div>
  );
}
