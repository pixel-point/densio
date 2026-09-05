"use client";

import type { ReactNode } from "react";
import { CodeLanguageProvider } from "./code-language-context";

export function Providers({ children }: { children: ReactNode }) {
  return <CodeLanguageProvider>{children}</CodeLanguageProvider>;
}
