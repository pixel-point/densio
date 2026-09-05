import { getRelatedPostCardDataBySlug } from "@/lib/blog/posts";
import { RelatedPostCardView, type IRelatedPostCard } from "@/components/content/related-posts";

async function RelatedPostCard({ className, slug }: IRelatedPostCard) {
  const post = await getRelatedPostCardDataBySlug(slug);

  if (!post) {
    return null;
  }

  return <RelatedPostCardView className={className} {...post} />;
}

export { RelatedPostCard };
