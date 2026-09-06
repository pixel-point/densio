import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import MobileMenu from "@/components/header/mobile-menu";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

it("keeps mobile navigation available for sign-in when marketing links are empty", () => {
  const html = renderToStaticMarkup(<MobileMenu items={[]} />);
  expect(html).toContain("Open menu");
  expect(html).toContain('aria-haspopup="dialog"');
});
