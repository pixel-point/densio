import { getPostDataBySlug } from "@/lib/blog/posts";
import { createSocialImageResponse } from "@/lib/og/create-social-image";

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ slug: string }>;
  },
) {
  const { slug } = await params;
  const post = await getPostDataBySlug(slug);

  return createSocialImageResponse({
    title: post?.seo?.title ?? post?.title ?? "Blog",
  });
}
