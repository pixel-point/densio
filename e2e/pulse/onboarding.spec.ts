import { expect, test } from "@playwright/test";

test("A visitor can copy the agent onboarding prompt", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Agent first video optimization" })).toBeVisible();
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied!", exact: true })).toBeVisible();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain("npx skills add pixel-point/densio --skill densio");
  expect(prompt).toContain("ask me which video to optimize");
  expect(prompt).toContain("save the compressed files in my project");
});

test("Get Started takes a visitor to email sign-in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Get Started", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByRole("heading", { name: "Log in to Densio" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email", exact: true })).toBeEditable();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeEnabled();
  await page.getByRole("link", { name: "Densio home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent first video optimization" })).toBeVisible();
});
