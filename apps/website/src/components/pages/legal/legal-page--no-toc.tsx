import type { ReactElement } from "react";

import { ITableOfContentsItem } from "@/types/common";
import Content from "@/components/pages/content";

interface LegalPageNoTocProps {
  title: string;
  updatedAt: string;
  formattedDate: string;
  content: ReactElement;
  tableOfContents: ITableOfContentsItem[];
}

export default function LegalPageNoToc({
  title,
  updatedAt,
  formattedDate,
  content,
}: LegalPageNoTocProps) {
  return (
    <main className="pt-10 pb-24 md:pt-16 md:pb-28 lg:pt-24 lg:pb-32 xl:pb-48">
      <div className="mx-auto flex max-w-3xl flex-col px-5 md:px-8">
        <article className="mx-auto flex flex-col gap-10 md:gap-16">
          <header className="flex flex-col gap-5">
            <h1 className="text-3xl leading-tight font-semibold tracking-tight md:text-5xl md:leading-tighter lg:text-6xl lg:leading-tighter">
              {title}
            </h1>
            <p className="text-lg leading-normal tracking-tight text-muted-foreground">
              Effective date: <time dateTime={updatedAt}>{formattedDate}</time>
            </p>
          </header>

          {content && <Content className="prose-clear-first-child prose-lg" content={content} />}
        </article>
      </div>
    </main>
  );
}
