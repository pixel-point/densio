import { expect, test } from "@playwright/test";

const pages = [
  { name: "Privacy Policy", path: "/privacy-policy" },
  { name: "Terms & Conditions", path: "/terms" },
];

for (const { name, path } of pages) {
  test(`A visitor can read ${name} from the homepage footer`, async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("contentinfo").getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", path);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("main").getByRole("heading", { level: 2 }).first()).toBeVisible();
  });
}
