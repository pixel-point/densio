import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const manifestPath = new URL("../package.json", import.meta.url);

describe("npm package metadata", () => {
  it("publishes a standalone Densio executable", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      bin: { densio: "dist/index.js" },
      engines: { node: ">=22.18" },
      files: ["dist/index.js"],
      license: "AGPL-3.0-only",
      name: "densio",
      publishConfig: { access: "public" },
    });
    expect(manifest).not.toHaveProperty("dependencies");
    expect(manifest).not.toHaveProperty("private");
  });
});
