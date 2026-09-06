import { expect, it } from "vitest";
import { accountPath, safeReturnTo, switchOrganizationPath } from "@/lib/densio/navigation";

it("preserves only supported settings sections when changing organizations", () => {
  expect(switchOrganizationPath("/app/first/settings/members", "second")).toBe(
    "/app/second/settings/members",
  );
  expect(switchOrganizationPath("/app/first/settings/billing", "second")).toBe(
    "/app/second/settings/billing",
  );
  expect(switchOrganizationPath("/app/first/settings/profile", "second")).toBe(
    "/app/second/settings/profile",
  );
  expect(switchOrganizationPath("/app/first/unrelated/settings", "second")).toBe(
    "/app/second/settings",
  );
  expect(accountPath("a/b")).toBe("/app/a%2Fb/settings");
});

it.each([
  "https://evil.test",
  "//evil.test",
  "/\\evil.test",
  "/app/../auth/login",
  "/app/first/settings?token=secret",
  "javascript:alert(1)",
  "/app/%2e%2e/auth/login",
])("rejects unsafe or unsupported login continuations: %s", (input) => {
  expect(safeReturnTo(input)).toBe("/app");
});

it("accepts private settings routes as login continuations", () => {
  expect(safeReturnTo("/app/org-id/settings/billing")).toBe("/app/org-id/settings/billing");
  expect(safeReturnTo(undefined)).toBe("/app");
});
