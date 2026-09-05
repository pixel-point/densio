import config from "@/configs/website-config";
import Rss from "rss";

import { getAllPosts } from "@/lib/blog/posts";

const SITE_URL = process.env.NEXT_PUBLIC_DEFAULT_SITE_URL!;

export async function GET() {
  try {
    const blogPosts = await getAllPosts();

    const feed = new Rss({
      language: "en",
      title: `Blog — ${config.projectName}`,
      description: "Latest blog posts",
      feed_url: `${SITE_URL}/blog/rss.xml`,
      site_url: SITE_URL,
      custom_namespaces: {
        media: "http://search.yahoo.com/mrss/",
      },
    });

    blogPosts.forEach(({ title, pathname, publishedAt, category, authors, caption, cover }) => {
      const url = `${SITE_URL}${pathname}`;
      feed.item({
        guid: pathname,
        title,
        description: caption || "",
        url,
        date: new Date(publishedAt),
        author: authors ? authors.map((author) => author.name).join(", ") : "",
        categories: category ? [category.title] : [],
        custom_elements: [
          {
            "media:thumbnail": {
              _attr: {
                url: cover,
              },
            },
          },
        ],
      });
    });

    return new Response(feed.xml(), {
      headers: {
        "Content-Type": "application/xml",
      },
    });
  } catch (error) {
    console.error("Error generating RSS feed:", error);
    return new Response("Error generating RSS feed", { status: 500 });
  }
}
