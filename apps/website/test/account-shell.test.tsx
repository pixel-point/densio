import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AccountShell } from "@/components/pages/account/shell";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/org/settings" }));

it("exposes an accessible account menu from the dashboard avatar", () => {
  const html = renderToStaticMarkup(
    <AccountShell organizations={[]} organizationId="org" email="user@densio.test">
      Account settings
    </AccountShell>,
  );
  expect(html).toMatch(/<button[^>]*aria-label="Account menu"/u);
});
