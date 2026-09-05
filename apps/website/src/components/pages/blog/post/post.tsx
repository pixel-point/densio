import { IPost } from "@/types/blog";
import { cn } from "@/lib/utils";
import Aside from "@/components/pages/aside";
import BackToTop from "@/components/pages/back-to-top";
import Content from "@/components/pages/content";
import TableOfContents from "@/components/pages/table-of-contents";

import PostHeader from "./post-header";
import SocialShare from "./social-share";

interface IPostProps {
  className?: string;
  post: IPost;
}

function Post({ className, post }: IPostProps) {
  return (
    <section className={cn("post", className)}>
      <div className="mx-auto w-full max-w-7xl px-5 md:px-8">
        <article className="grid w-full grid-cols-1 gap-y-10 md:gap-y-16 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-y-20 xl:grid-cols-[16rem_minmax(0,1fr)_16rem]">
          <PostHeader
            className="col-start-1 row-start-1 w-full min-w-0 xl:col-start-2"
            post={post}
          />
          <div className="col-start-1 row-start-2 min-w-0 xl:col-start-2">
            <Content className="prose-clear-first-child prose-lg" content={post.content} />
            <SocialShare className="mt-11 md:mt-14" pathname={`/blog/${post.slug.current}`} />
          </div>

          <Aside
            className="col-start-2 row-start-2 hidden w-full min-w-0 shrink-0 flex-col pl-16 lg:flex xl:col-start-3"
            sticky
          >
            <TableOfContents className="mt-1.5" title="On this page" items={post.tableOfContents} />
            <BackToTop withSeparator />
          </Aside>
        </article>
      </div>
    </section>
  );
}

export default Post;
