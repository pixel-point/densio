import { ArrowLeft } from "lucide-react";

import { IPost } from "@/types/blog";
import { cn } from "@/lib/utils";
import { Link } from "@/components/ui/link";
import { Separator } from "@/components/ui/separator";
import Authors from "@/components/pages/authors";
import Date from "@/components/pages/date";

interface IPostHeaderProps {
  className?: string;
  post: IPost;
}

function PostHeader({ className, post }: IPostHeaderProps) {
  const { title, authors, category, publishedAt, caption, readingTime } = post;

  return (
    <header className={cn("post-header", className)}>
      <nav className="flex" aria-label="Breadcrumb">
        <ol className="flex min-w-0 items-center" role="list">
          <li className="flex items-center">
            <Link
              className="group gap-x-0.5 leading-none whitespace-nowrap"
              variant="muted"
              size="sm"
              href="/blog"
            >
              <ArrowLeft
                className="size-3.5 transition-transform duration-300 group-hover:-translate-x-0.5"
                size={14}
                strokeWidth={2.5}
                aria-hidden
              />
              <span>Blog</span>
            </Link>
          </li>
          <li className="flex items-center">
            <span
              className="mx-2.5 text-sm leading-none font-medium tracking-tight text-muted-foreground"
              aria-hidden
            >
              /
            </span>
            <Link
              className="leading-none whitespace-nowrap"
              href={`/blog/category/${category.slug.current}`}
              size="sm"
              variant="muted"
              aria-current="page"
            >
              {category.title}
            </Link>
          </li>
        </ol>
      </nav>
      <h1 className="mt-5 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl md:leading-tight lg:text-5xl lg:leading-tighter lg:font-medium">
        {title}
      </h1>
      <p className="mt-4 text-lg leading-snug tracking-tight text-balance text-foreground/80 md:text-xl md:leading-snug lg:text-2xl lg:leading-snug">
        {caption}
      </p>
      <Separator className="my-5" />
      <div className="flex items-center justify-between gap-3">
        <Authors authors={authors} size="xs" hideNamesOn={["sm"]} />
        <div className="flex items-center">
          <Date className="md:text-sm md:leading-none" publishedAt={publishedAt} />
          <div className="mx-2 size-1 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
          <time
            className="text-[0.8125rem] leading-none font-medium tracking-tight text-muted-foreground md:text-sm"
            aria-label={`Read time: ${readingTime}`}
          >
            {readingTime}
          </time>
        </div>
      </div>
    </header>
  );
}

export default PostHeader;
