import { expect, it } from "vitest";
import { createApp } from "../src/app.ts";

it.each([
  ["/billing/success", "/checkout/success"],
  ["/billing/canceled", "/checkout/canceled"],
  ["/billing", "/billing"],
])("redirects the old browser billing route %s to the website", async (path, destination) => {
  const response = await createApp().request(path);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`http://localhost:3001${destination}`);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
