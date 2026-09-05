import fs from "fs";
import path from "path";

import { cache, createElement, type ComponentType } from "react";
import config from "@/configs/website-config";
import matter from "gray-matter";
import type { MDXComponents } from "mdx/types";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { type ITableOfContentsItem } from "@/types/common";
import { removeMarkdownSymbols } from "@/lib/markdown-text";
import remarkHeading from "@/lib/mdx-plugins/remark-heading.mjs";
import { getComponents } from "@/components/content/get-components";
import { RelatedPostCard } from "@/components/content/related-posts-server";

export interface CompileMdxOptions {
  allowMediaBreakout?: boolean;
  contentWidth?: number;
}

export type ContentCollection = "blog" | "legal";

type TMarkdownDataResponse<T> = {
  data: T;
  content: string;
};

export interface ContentModule {
  default: ComponentType<{ components?: MDXComponents }>;
  metadata?: Record<string, unknown>;
}

interface ContentSourceData {
  filePath: string;
  relativePath: string;
  plainText: string;
  toc: ITableOfContentsItem[];
}

interface ResolvedContentFile {
  absolutePath: string;
  relativePath: string;
}

const CONTENT_DIRS: Record<ContentCollection, string> = {
  blog: path.join(process.cwd(), config.blog.contentDir),
  legal: path.join(process.cwd(), config.legal.contentDir, "legal"),
};

const MARKDOWN_EXTENSIONS = [".mdx", ".md"] as const;

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeModuleKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\.(md|mdx)$/i, "");
}

function getCandidateRelativePaths(moduleKey: string): string[] {
  const normalized = normalizeModuleKey(moduleKey).replace(/^\/+|\/+$/g, "");

  if (!normalized) {
    return MARKDOWN_EXTENSIONS.map((extension) => `index${extension}`);
  }

  return [
    ...MARKDOWN_EXTENSIONS.map((extension) => `${normalized}${extension}`),
    ...MARKDOWN_EXTENSIONS.map((extension) => path.posix.join(normalized, `index${extension}`)),
  ];
}

function resolveContentFile(
  collection: ContentCollection,
  moduleKey: string,
): ResolvedContentFile | null {
  const candidates = getCandidateRelativePaths(moduleKey);
  const baseDir = CONTENT_DIRS[collection];

  for (const relativePath of candidates) {
    const absolutePath = path.join(baseDir, relativePath);

    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    return {
      absolutePath,
      relativePath: toPosix(relativePath),
    };
  }

  return null;
}

function extractTableOfContents(markdown: string): ITableOfContentsItem[] {
  const toc: ITableOfContentsItem[] = [];
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkFrontmatter, ["yaml", "toml"])
    .use(remarkGfm)
    .use(remarkHeading, { tocRef: toc });

  const tree = processor.parse(markdown);
  processor.runSync(tree);

  return toc;
}

const getContentModuleCached = cache(async function getContentModuleCached(
  collection: ContentCollection,
  moduleKey: string,
): Promise<ContentModule> {
  const resolved = resolveContentFile(collection, moduleKey);

  if (!resolved) {
    throw new Error(`Missing ${collection} MDX module for "${moduleKey}".`);
  }

  switch (collection) {
    case "blog":
      return (await import(`@/content/blog/${resolved.relativePath}`)) as ContentModule;
    case "legal":
      return (await import(`@/content/legal/${resolved.relativePath}`)) as ContentModule;
  }
});

export async function getContentModule(
  collection: ContentCollection,
  moduleKey: string,
): Promise<ContentModule> {
  return getContentModuleCached(collection, moduleKey);
}

export async function compileMdx(
  collection: ContentCollection,
  moduleKey: string,
  opts: CompileMdxOptions = {},
): Promise<{
  content: ReturnType<typeof createElement>;
  toc: ITableOfContentsItem[];
  plainText: string;
  filePath: string;
  relativePath: string;
}> {
  const sourceData = getContentSourceData(collection, moduleKey);
  const contentModule = await getContentModule(collection, moduleKey);
  const Content = contentModule.default;
  const components = getComponents({
    allowMediaBreakout: opts.allowMediaBreakout ?? false,
    contentWidth: opts.contentWidth ?? 704,
    relatedPostCardComponent: RelatedPostCard,
  });

  return {
    content: createElement(Content, {
      components: components as MDXComponents,
    }),
    toc: sourceData.toc,
    plainText: sourceData.plainText,
    filePath: sourceData.filePath,
    relativePath: sourceData.relativePath,
  };
}

const getContentSourceDataCached = cache(function getContentSourceDataCached(
  collection: ContentCollection,
  moduleKey: string,
): ContentSourceData {
  const resolved = resolveContentFile(collection, moduleKey);

  if (!resolved) {
    throw new Error(`Missing ${collection} MDX source file for "${moduleKey}".`);
  }

  const source = fs.readFileSync(resolved.absolutePath, "utf-8");
  const { content } = matter(source);

  return {
    filePath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    plainText: removeMarkdownSymbols(content),
    toc: extractTableOfContents(content),
  };
});

export function getContentSourceData(
  collection: ContentCollection,
  moduleKey: string,
): ContentSourceData {
  return getContentSourceDataCached(collection, moduleKey);
}

/**
 * Reads and parses markdown file with frontmatter
 * @param filePath - Path to the markdown file
 * @throws {Error} When file cannot be read or parsed
 *
 * @returns Object containing parsed frontmatter data and content
 */
export function readAndParseMarkdown<T>(filePath: string): TMarkdownDataResponse<T> {
  try {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const result = matter(fileContent) as matter.GrayMatterFile<string>;

    return {
      data: result.data as T,
      content: result.content,
    };
  } catch (error) {
    console.error(`Error reading markdown file: ${filePath}`, error);
    throw new Error(`Failed to read markdown file: ${filePath}`);
  }
}
