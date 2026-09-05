import "@/styles/globals.css";
import type { Viewport } from "next";
import config from "@/configs/website-config";
import { fontVariablesClassName } from "@/lib/theme-fonts";

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: config.metaThemeColor,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={fontVariablesClassName}>
      <body className="flex min-h-svh flex-col bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
