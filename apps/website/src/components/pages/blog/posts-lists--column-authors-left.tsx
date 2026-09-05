import type { IPostData } from "@/types/blog";
import { cn } from "@/lib/utils";
import { Link } from "@/components/ui/link";
import Authors from "@/components/pages/authors";
import Category from "@/components/pages/blog/category";
import Date from "@/components/pages/date";

interface IPostCardProps {
  className?: string;
  post: IPostData;
}

interface IPostsListProps {
  className?: string;
  title?: string;
  posts: IPostData[];
}

function PostCard({ className, post }: IPostCardProps) {
  const { authors, isFeatured, publishedAt, title, pathname, caption, category } = post;

  return (
    <article
      className={cn(
        "post-card flex flex-col justify-between gap-x-8 gap-y-3 md:flex-row",
        className,
      )}
    >
      <div className="flex w-full flex-row-reverse items-center justify-end gap-x-2 gap-y-4 md:w-40 md:shrink-0 md:flex-col md:items-start md:justify-start md:pt-2 lg:w-56">
        <Date publishedAt={publishedAt} />
        <div className="size-1 shrink-0 rounded-full bg-muted-foreground md:hidden" aria-hidden />
        <Category
          className={cn(!isFeatured && "flex md:hidden")}
          isFeatured={isFeatured}
          category={category}
        />
        <Authors
          className="hidden shrink-0 md:flex"
          authors={authors}
          size="xs"
          hideNamesOn={["md"]}
        />
      </div>
      <div className="flex grow flex-col">
        <h1>
          <Link
            className="line-clamp-2 max-w-xl text-xl leading-snug text-pretty lg:text-2xl lg:leading-snug"
            href={pathname}
            variant="foreground"
          >
            {title}
          </Link>
        </h1>
        <p className="mt-2 line-clamp-2 text-base tracking-tight text-muted-foreground lg:mt-3 lg:text-lg lg:leading-snug">
          {caption}
        </p>
        <Authors className="mt-3 shrink-0 md:hidden lg:mt-4" authors={authors} size="xs" />
      </div>
    </article>
  );
}

function PostsList({ className, title, posts }: IPostsListProps) {
  return (
    <section className={cn("posts-list flex flex-col", className)}>
      {title && <h2 className="sr-only">{title}</h2>}
      <div className="flex flex-col gap-y-12 md:gap-y-14">
        {posts.map((post, index) => (
          <PostCard key={index} post={post} />
        ))}
      </div>
    </section>
  );
}

export default PostsList;
