import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/pulse",
  fullyParallel: false,
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: ".siteos/pulse/test-results",
  reporter: "list",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "https://densio.sh",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
