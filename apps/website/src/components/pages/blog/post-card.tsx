import { IPostData } from "@/types/blog";
import { cn } from "@/lib/utils";
import { Link } from "@/components/ui/link";
import Authors from "@/components/pages/authors";
import CategoryAndDate from "@/components/pages/blog/category-and-date";
import Image from "next/image";

interface IPostCardProps {
  className?: string;
  post: IPostData;
}

function PostCard({ className, post }: IPostCardProps) {
  const { cover, authors, category, publishedAt, title, pathname, caption } = post;

  return (
    <article className={cn("flex flex-col gap-y-4", className)}>
      <Link
        className="overflow-hidden rounded-md lg:rounded-lg"
        variant="ghost"
        size="none"
        href={pathname}
      >
        <Image
          className="aspect-video h-auto w-full object-cover"
          src={cover}
          width={302}
          height={Math.ceil(302 / (16 / 9))}
          alt=""
          quality={100}
        />
      </Link>
      <div className="flex flex-col">
        <CategoryAndDate category={category} publishedAt={publishedAt} />
        <h1 className="mt-2.5 font-heading">
          <Link
            className="line-clamp-4 text-lg leading-snug text-pretty"
            href={pathname}
            variant="foreground"
          >
            {title}
          </Link>
        </h1>

        <p className="mt-1.5 line-clamp-3 text-sm leading-snug tracking-tight text-foreground/80 md:text-base md:leading-snug">
          {caption}
        </p>

        <Authors className="mt-2.5" authors={authors} />
      </div>
    </article>
  );
}

export default PostCard;
