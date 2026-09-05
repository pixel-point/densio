import { IPostData } from "@/types/blog";
import { cn } from "@/lib/utils";
import { Link } from "@/components/ui/link";
import CategoryAndDate from "@/components/pages/blog/category-and-date";
import Image from "next/image";

import Authors from "../authors";

interface IFeaturedPostProps {
  className?: string;
  posts: IPostData[];
}

function FeaturedPost({ className, posts }: IFeaturedPostProps) {
  if (posts.length === 0) {
    return null;
  }

  const [featuredPost, ...restPosts] = posts.slice(0, 4);

  return (
    <section className={cn("featured-posts--grid", className)}>
      <h2 className="sr-only font-heading">Featured posts</h2>
      <div className="grid grid-cols-1 gap-x-16 gap-y-12 md:grid-cols-[22rem_auto] lg:grid-cols-[26rem_auto] xl:grid-cols-[30rem_auto]">
        <article className="flex flex-col">
          <Link
            className="shrink-0 overflow-hidden rounded-lg"
            variant="ghost"
            size="none"
            href={featuredPost.pathname}
          >
            <Image
              className="aspect-video h-auto w-full object-cover"
              src={featuredPost.cover}
              width={480}
              height={270}
              quality={100}
              alt=""
              preload
            />
            <span className="sr-only">Read post {featuredPost.title}</span>
          </Link>
          <CategoryAndDate
            className="mt-6 md:hidden"
            category={featuredPost.category}
            publishedAt={featuredPost.publishedAt}
            isFeatured={featuredPost.isFeatured}
          />
          <h1 className="mt-3">
            <Link
              className="line-clamp-3 text-xl leading-snug text-pretty md:text-2xl md:leading-tight lg:mt-4 lg:line-clamp-2 lg:text-[1.75rem] lg:leading-tight"
              variant="foreground"
              href={featuredPost.pathname}
            >
              {featuredPost.title}
            </Link>
          </h1>
          <p className="mt-2 line-clamp-3 text-base leading-normal tracking-tight text-muted-foreground md:hidden">
            {featuredPost.caption}
          </p>
          <Authors className="mt-3 shrink-0 md:hidden" authors={featuredPost.authors} size="xs" />
        </article>
        <div className="flex flex-col gap-y-7 lg:gap-y-8">
          {restPosts.map(
            ({ title, category, publishedAt, pathname, isFeatured, caption, authors }, index) => (
              <article className="flex flex-col" key={index}>
                <CategoryAndDate
                  className="hidden md:flex"
                  category={category}
                  publishedAt={publishedAt}
                />
                <CategoryAndDate
                  className="md:hidden"
                  category={category}
                  publishedAt={publishedAt}
                  isFeatured={isFeatured}
                />
                <h1 className="mt-3">
                  <Link
                    className="line-clamp-2 text-xl leading-snug text-pretty"
                    variant="foreground"
                    href={pathname}
                  >
                    {title}
                  </Link>
                </h1>
                <p className="mt-2 line-clamp-3 text-base leading-normal tracking-tight text-muted-foreground md:hidden">
                  {caption}
                </p>
                <Authors className="mt-3 shrink-0 md:hidden" authors={authors} size="xs" />
              </article>
            ),
          )}
        </div>
      </div>
    </section>
  );
}

export default FeaturedPost;
