"use client";

import { usePathname } from "next/navigation";
import { cva } from "class-variance-authority";

import { ICategory } from "@/types/blog";
import { cn } from "@/lib/utils";
import { Link } from "@/components/ui/link";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

interface ICategoriesListProps {
  className?: string;
  categories: ICategory[];
  variant?: "underline" | "outline";
}

const activeTabVariants = cva("absolute", {
  variants: {
    variant: {
      underline: "inset-x-0 bottom-0 h-0.5 bg-primary",
      outline: "inset-0 rounded-full border",
    },
  },
  defaultVariants: {
    variant: "outline",
  },
});

function CategoriesList({ className, categories, variant = "outline" }: ICategoriesListProps) {
  const pathname = usePathname();
  const isUnderlineVariant = variant === "underline";
  const isBlogRouteContext = pathname.startsWith("/blog");
  const canonicalAllPostsCategory: ICategory = {
    title: "All posts",
    url: "/blog",
    slug: { current: "all-posts" },
  };
  const existingAllPostsIndex = categories.findIndex(
    ({ title, url, slug }) =>
      url === "/blog" || slug.current === "all-posts" || title.toLowerCase() === "all posts",
  );
  const normalizedCategories =
    existingAllPostsIndex === -1
      ? [canonicalAllPostsCategory, ...categories]
      : [
          {
            ...categories[existingAllPostsIndex],
            ...canonicalAllPostsCategory,
            slug: categories[existingAllPostsIndex]?.slug ?? canonicalAllPostsCategory.slug,
          },
          ...categories.filter((_, index) => index !== existingAllPostsIndex),
        ];

  return (
    <section className={cn("categories-list max-w-full md:overflow-hidden", className)}>
      <h2 className="sr-only font-heading">Categories</h2>
      <nav className="relative -mx-5 md:mx-0">
        <ScrollArea className="w-full">
          <ul
            className={cn(
              "flex h-8 w-full items-center px-5 md:pl-0",
              isUnderlineVariant ? "gap-x-5" : "gap-x-0.5",
            )}
          >
            {normalizedCategories.map(({ title, url }, index) => {
              const isAllPostsCategory = url === "/blog";
              const isActive = isAllPostsCategory
                ? isBlogRouteContext
                  ? pathname === "/blog" || pathname.startsWith("/blog/page")
                  : true
                : isBlogRouteContext && (pathname === url || pathname.startsWith(`${url}/page`));
              const shouldShowHighlight = isActive;
              return (
                <li key={index}>
                  <Link
                    className={cn(
                      "relative h-8 justify-center rounded-full leading-none font-medium whitespace-nowrap transition-colors duration-200 ring-inset",
                      shouldShowHighlight
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground/80",
                      !isUnderlineVariant && "px-3.5",
                    )}
                    size="sm"
                    variant="ghost"
                    href={url}
                  >
                    <span className="relative z-10">{title}</span>
                    <span
                      className={cn(
                        "pointer-events-none z-0 transition-opacity duration-300",
                        activeTabVariants({ variant }),
                        !isUnderlineVariant && isActive && "border-muted-foreground",
                        shouldShowHighlight ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
          <ScrollBar className="invisible" orientation="horizontal" />
        </ScrollArea>
        <span
          className="pointer-events-none absolute inset-y-0 right-0 z-20 flex w-6 bg-linear-to-r from-transparent via-background/80 via-50% to-background"
          aria-hidden
        />
        <span
          className="pointer-events-none absolute inset-y-0 left-0 z-20 flex w-6 bg-linear-to-l from-transparent via-background/80 via-50% to-background md:hidden"
          aria-hidden
        />
      </nav>
    </section>
  );
}
export default CategoriesList;
