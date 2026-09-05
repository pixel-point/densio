import fs from "fs";
import path from "path";

import { cache } from "react";
import { Route } from "next";
import config from "@/configs/website-config";
import { authors as authorsList } from "@/content/blog/taxonomy/authors";
import { categories } from "@/content/blog/taxonomy/categories";
import { globSync } from "glob";

import { ICategory, IPost, IPostData, IPostMeta } from "@/types/blog";
import { compileMdx, getContentModule, getContentSourceData } from "@/lib/markdown";
import { getExcerpt, getTimeToRead } from "@/lib/utils";

const POSTS_PER_PAGE = config.blog.postsPerPage;
const BLOG_DIR_PATH = path.join(process.cwd(), config.blog.contentDir);
const MARKDOWN_EXTENSIONS = [".md", ".mdx"] as const;

export type RelatedPostCardData = Pick<IPostData, "title" | "authors" | "publishedAt" | "pathname">;

function getPostSlugsByPath(globPattern: string, ignore: string[] = []): string[] {
  const files = globSync(globPattern, {
    cwd: BLOG_DIR_PATH,
    ignore: ["**/CONTRIBUTING.md", ...ignore],
    absolute: true,
  });

  return files.map((filePath: string) => {
    const relativePath = path.relative(BLOG_DIR_PATH, filePath);
    return relativePath.replace(/\.(md|mdx)$/i, "");
  });
}

function resolveBlogPostFile(slug: string): { rel: string } | null {
  for (const extension of MARKDOWN_EXTENSIONS) {
    const relPath = `${slug}${extension}`;
    const filePath = path.join(BLOG_DIR_PATH, relPath);

    if (fs.existsSync(filePath)) {
      return {
        rel: relPath,
      };
    }
  }

  return null;
}

function transformCategory(frontmatterCategory: IPostMeta["category"]): ICategory {
  const matchedCategory = categories.find((c) => c.slug.current === frontmatterCategory);

  if (!matchedCategory) {
    throw new Error(`Unknown category "${frontmatterCategory}".`);
  }

  return {
    ...matchedCategory,
    url: `/blog/category/${matchedCategory.slug.current}` as Route<string>,
  };
}

function resolveAuthors(authorRefs: IPostMeta["authors"]): IPostData["authors"] {
  return (authorRefs ?? []).map((author) => {
    const id = typeof author === "string" ? author : author.id;
    const matchedAuthor = authorsList.find((item) => item.id === id);

    if (!matchedAuthor) {
      throw new Error(`Unknown author "${id}".`);
    }

    return matchedAuthor;
  });
}

const getBlogPostSourceBySlugCached = cache(async function getBlogPostSourceBySlugCached(
  slug: string,
): Promise<{ rel: string; data: IPostMeta } | null> {
  try {
    const resolved = resolveBlogPostFile(slug);

    if (!resolved) {
      console.error(`Post not found: ${slug}`);
      return null;
    }

    const contentModule = await getContentModule("blog", resolved.rel);
    const data = contentModule.metadata as IPostMeta | undefined;
    const isProduction = process.env.NEXT_PUBLIC_VERCEL_ENV === "production";

    if (!data) {
      console.error(`Post not found: ${slug}`);
      return null;
    }

    if (isProduction && data.isDraft) {
      return null;
    }

    return {
      rel: resolved.rel,
      data,
    };
  } catch (error) {
    console.error(`Error fetching the post by slug: ${slug}`, error);
    return null;
  }
});

export const getRelatedPostCardDataBySlug = cache(async function getRelatedPostCardDataBySlug(
  slug: string,
): Promise<RelatedPostCardData | null> {
  const source = await getBlogPostSourceBySlugCached(slug);

  if (!source) {
    return null;
  }

  return {
    title: source.data.title,
    authors: resolveAuthors(source.data.authors),
    publishedAt: source.data.publishedAt,
    pathname: `/blog/${slug}`,
  };
});

const getPostDataBySlugCached = cache(async function getPostDataBySlugCached(
  slug: string,
): Promise<IPostData | null> {
  try {
    const source = await getBlogPostSourceBySlugCached(slug);

    if (!source) {
      return null;
    }

    const { rel, data } = source;
    const {
      title,
      seo,
      isDraft,
      publishedAt,
      caption,
      cover,
      authors: authorRefs,
      isFeatured,
    } = data;

    const { plainText } = getContentSourceData("blog", rel);
    const category = transformCategory(data.category);
    const resolvedAuthors = resolveAuthors(authorRefs);
    const readingTime = getTimeToRead(plainText);

    return {
      slug: { current: slug },
      pathname: `/blog/${slug}`,
      title,
      authors: resolvedAuthors,
      cover: cover || "",
      isFeatured: Boolean(isFeatured),
      isDraft: Boolean(isDraft),
      publishedAt,
      caption: caption ?? "",
      content: plainText,
      category,
      readingTime,
      seo: {
        title: seo?.title ?? title,
        description: seo?.description ?? caption ?? getExcerpt({ content: plainText, length: 160 }),
        socialImage: seo?.socialImage ?? `/blog/${slug}/opengraph-image`,
        noIndex: seo?.noIndex ?? Boolean(isDraft),
      },
    };
  } catch (error) {
    console.error(`Error fetching the post by slug: ${slug}`, error);
    return null;
  }
});

async function getPostDataBySlug(slug: string): Promise<IPostData | null> {
  return getPostDataBySlugCached(slug);
}

const getAllPostsCached = cache(async function getAllPostsCached(): Promise<IPostData[]> {
  const slugs = getPostSlugsByPath("**/*.{md,mdx}");
  const posts = await Promise.all(slugs.map((slug) => getPostDataBySlug(slug)));

  const filtered = posts.filter((post): post is IPostData => Boolean(post));

  filtered.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  return filtered;
});

async function getAllPosts(): Promise<IPostData[]> {
  return getAllPostsCached();
}

const getPostBySlugCached = cache(async function getPostBySlugCached(
  slug: string,
): Promise<IPost | null> {
  try {
    const resolved = resolveBlogPostFile(slug);
    const postData = await getPostDataBySlug(slug);

    if (!postData || !resolved) {
      return null;
    }

    const { content: compiledMdx, toc: tableOfContents } = await compileMdx("blog", resolved.rel);

    return {
      ...postData,
      content: compiledMdx,
      tableOfContents,
    };
  } catch (error) {
    console.error(`Error fetching the post by slug: ${slug}`, error);
    return null;
  }
});

async function getPostBySlug(slug: string): Promise<IPost | null> {
  return getPostBySlugCached(slug);
}

const getCategoriesCached = cache(async function getCategoriesCached(): Promise<ICategory[]> {
  const posts = await getAllPosts();
  const usedCategorySlugs = new Set(posts.map((post) => post.category.slug.current));

  return categories
    .filter((cat) => usedCategorySlugs.has(cat.slug.current))
    .map((cat) => ({
      ...cat,
      url: `/blog/category/${cat.slug.current}` as Route<string>,
    }));
});

async function getCategories(): Promise<ICategory[]> {
  return getCategoriesCached();
}

const getCategoryBySlugCached = cache(async function getCategoryBySlugCached(
  slug: string,
): Promise<ICategory | null> {
  const cats = await getCategories();
  return cats.find((cat) => cat.slug.current === slug) || null;
});

async function getCategoryBySlug(slug: string): Promise<ICategory | null> {
  return getCategoryBySlugCached(slug);
}

async function getPostsByCategory(slug: string): Promise<IPostData[]> {
  const posts = await getAllPosts();
  return posts.filter((post) => post.category.slug.current === slug);
}

async function getFeaturedPost(): Promise<IPostData[] | null> {
  const posts = (await getAllPosts()).filter((post) => post.isFeatured);
  return posts.length > 0 ? posts : null;
}

async function getPostCounts(): Promise<{
  total: number;
  nonFeatured: number;
}> {
  const allPosts = await getAllPosts();
  return {
    total: allPosts.length,
    nonFeatured: allPosts.filter((post) => !post.isFeatured).length,
  };
}

async function getPostCountsByCategory(
  slug: string,
): Promise<{ total: number; nonFeatured: number }> {
  const posts = await getPostsByCategory(slug);
  return {
    total: posts.length,
    nonFeatured: posts.filter((post) => !post.isFeatured).length,
  };
}

async function getTotalPages(): Promise<number> {
  const { nonFeatured } = await getPostCounts();
  if (nonFeatured <= 1) return nonFeatured;
  return Math.ceil(nonFeatured / POSTS_PER_PAGE);
}

async function getTotalPagesByCategory(slug: string): Promise<number> {
  const { nonFeatured } = await getPostCountsByCategory(slug);
  if (nonFeatured <= 1) return nonFeatured;
  return Math.ceil(nonFeatured / POSTS_PER_PAGE);
}

async function getPaginatedPosts(
  page = 1,
  options?: { nonFeaturedOnly?: boolean },
): Promise<IPostData[]> {
  const allPosts = await getAllPosts();
  const posts = options?.nonFeaturedOnly ? allPosts.filter((post) => !post.isFeatured) : allPosts;

  const start = (page - 1) * POSTS_PER_PAGE;
  const end = start + POSTS_PER_PAGE;

  return posts.slice(start, end);
}

async function getPaginatedPostsByCategory(
  slug: string,
  page = 1,
  options?: { nonFeaturedOnly?: boolean },
): Promise<IPostData[]> {
  const postsInCategory = await getPostsByCategory(slug);
  const filtered = options?.nonFeaturedOnly
    ? postsInCategory.filter((post) => !post.isFeatured)
    : postsInCategory;

  const start = (page - 1) * POSTS_PER_PAGE;
  const end = start + POSTS_PER_PAGE;

  return filtered.slice(start, end);
}

export {
  getPostDataBySlug,
  getPostBySlug,
  getAllPosts,
  getCategories,
  getCategoryBySlug,
  getFeaturedPost,
  getPostsByCategory,
  getPostCounts,
  getPostCountsByCategory,
  getTotalPages,
  getTotalPagesByCategory,
  getPaginatedPosts,
  getPaginatedPostsByCategory,
};
