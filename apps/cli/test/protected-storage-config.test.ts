import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { StorageConnectionFileSchema } from "../src/storage-commands.ts";
import { readProtectedJson } from "../src/protected-json-input.ts";
import { cleanupCliDirectories, makeCliCapture } from "./cli-test-support.ts";
afterEach(cleanupCliDirectories);
test("a protected connection file may leave its display name to the CLI flag", async () => {
  const capture = await makeCliCapture();
  const path = join(capture.directory, "storage.json");
  await writeFile(
    path,
    JSON.stringify({
      config: {
        provider: "s3",
        visibility: "private",
        location: {
          endpoint: "https://s3.example.com",
          region: "auto",
          bucket: "video-bucket",
          prefix: "",
          pathStyle: true,
        },
      },
      credentials: { accessKeyId: "key", secretAccessKey: "secret" },
    }),
  );
  await chmod(path, 0o600);
  expect(await readProtectedJson(path, StorageConnectionFileSchema)).not.toHaveProperty("name");
});
