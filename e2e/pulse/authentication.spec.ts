import { expect, test } from "@playwright/test";

test("Email sign-in rejects empty and malformed input without sending a request", async ({
  page,
}) => {
  const blockedWrites: string[] = [];
  // Keep this production monitor safe even if native form validation regresses.
  await page.route("**/*", async (route) => {
    const method = route.request().method();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
    blockedWrites.push(method);
    await route.abort("blockedbyclient");
  });
  const response = await page.goto("/auth/login");
  expect(response?.status()).toBe(200);
  const email = page.getByRole("textbox", { name: "Email", exact: true });
  const submit = page.getByRole("button", { name: "Continue with email" });
  await expect(email).toHaveAttribute("type", "email");
  await expect(email).toHaveAttribute("required", "");
  await submit.click();
  await expect(email).toBeFocused();
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await email.fill("invalid-email");
  await submit.click();
  await expect(email).toBeFocused();
  expect(await email.evaluate((input: HTMLInputElement) => input.validity.typeMismatch)).toBe(true);
  await expect(page.getByRole("heading", { name: "Log in to Densio" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
  expect(blockedWrites).toEqual([]);
});

test("An anonymous account visit preserves the sign-in return destination", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fapp$/);
  await expect(page.getByRole("heading", { name: "Log in to Densio" })).toBeVisible();
  await expect(page.locator('input[name="returnTo"]')).toHaveValue("/app");
});

test("Login ignores an external return destination", async ({ page }) => {
  await page.goto("/auth/login?returnTo=https%3A%2F%2Fexample.com");
  await expect(page.getByRole("heading", { name: "Log in to Densio" })).toBeVisible();
  await expect(page.locator('input[name="returnTo"]')).toHaveValue("/app");
});

test("A canceled checkout offers a working route back to the account", async ({ page }) => {
  const response = await page.goto("/checkout/canceled");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Checkout canceled" })).toBeVisible();
  await page.getByRole("link", { name: "Go to billing", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/login\?returnTo=%2Fapp$/);
  await expect(page.getByRole("heading", { name: "Log in to Densio" })).toBeVisible();
});
