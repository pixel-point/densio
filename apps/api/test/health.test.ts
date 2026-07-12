import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.ts";

describe("health route", () => {
  it("returns an ok status payload", async () => {
    const response = await createApp().request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
    });
  });
});
