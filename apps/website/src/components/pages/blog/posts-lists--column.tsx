import type { IPostData } from "@/types/blog";

import PostsListAuthorsBottom from "./posts-lists--column-authors-bottom";
import PostsListAuthorsLeft from "./posts-lists--column-authors-left";

interface IPostsListProps {
  className?: string;
  title?: string;
  posts: IPostData[];
  authorsPosition?: "left" | "bottom";
}

function PostsList({ className, title, posts, authorsPosition = "bottom" }: IPostsListProps) {
  const Component = authorsPosition === "left" ? PostsListAuthorsLeft : PostsListAuthorsBottom;

  return <Component className={className} title={title} posts={posts} />;
}

export default PostsList;
