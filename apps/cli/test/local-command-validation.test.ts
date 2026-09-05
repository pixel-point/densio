import { afterEach, expect, test } from "vitest";
import { runCli } from "../src/cli.ts";
import { cleanupCliDirectories, makeCliCapture } from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);
test.each([
  ["storage", "get"],
  ["storage", "list", "unexpected"],
  ["storage", "retry", "transfer-id"],
  ["storage", "connect"],
  ["videos", "rename", "video-id"],
  ["videos", "visibility", "video-id", "invalid", "--idempotency-key", "key"],
  ["videos", "list", "--limit", "0"],
  ["videos", "list", "--state", "invalid"],
  ["videos", "download", "video-id"],
  ["jobs", "create", "source-id", "compress", "--options-file", "/missing/densio-options.json"],
])("invalid local input fails before authentication: %j", async (...args) => {
  const capture = await makeCliCapture();
  const requests: string[] = [];
  const code = await runCli([...args, "--api-url", "http://127.0.0.1:1", "--json"], {
    ...capture.dependencies,
    fetch: async (input) => {
      requests.push(String(input));
      throw new Error("Unexpected network request");
    },
  });
  expect(code).toBe(2);
  expect(requests).toEqual([]);
  expect(capture.stdout()).toBe("");
});
