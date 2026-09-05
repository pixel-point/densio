import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 20_000,
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
  },
});
