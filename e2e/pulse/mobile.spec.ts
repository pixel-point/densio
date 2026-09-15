import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("Mobile visitors can open the menu and reach email sign-in", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Agent first video optimization" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Menu", exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "Sign in to Densio", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeInViewport();
});
