import { expect, it } from "vitest";

import { createApp } from "../src/app.ts";

it.each([
  ["/billing/success", "Checkout completed"],
  ["/billing/canceled", "Checkout canceled"],
  ["/billing", "Billing session complete"],
])("serves a safe human billing return page at %s", async (path, heading) => {
  const response = await createApp().request(path);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  await expect(response.text()).resolves.toContain(heading);
});
