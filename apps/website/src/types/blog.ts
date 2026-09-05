import { type ReactElement } from "react";
import { type Route } from "next";

import {
  type IAuthorData,
  type ISeoFields,
  type ISlug,
  type ITableOfContentsItem,
} from "@/types/common";

export interface ICategoryData {
  title: string;
  slug: ISlug;
}

export interface ICategory extends ICategoryData {
  url: Route<string>;
}

export interface IPostMeta {
  title: string;
  caption: string;
  slug: ISlug;
  authors?: (string | { id: string })[];
  category: string;
  cover: string;
  isFeatured?: boolean;
  isDraft?: boolean;
  content: string;
  publishedAt: string;
  seo: ISeoFields;
}

export interface IPostData extends Omit<IPostMeta, "authors" | "category"> {
  pathname: string;
  authors: IAuthorData[];
  category: ICategory;
  readingTime: string;
}

export interface IPost extends Omit<IPostData, "content"> {
  content: ReactElement;
  tableOfContents: ITableOfContentsItem[];
}
