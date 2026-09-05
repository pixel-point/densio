import { expect, test } from "vitest";
import { uploadDirectParts } from "../src/source-storage-upload.ts";
import { makeCliRuntime } from "../src/runtime.ts";

test("S3 data uploads contain only provider action headers and never Densio authorization", async () => {
  const calls: RequestInit[] = [];
  const runtime = makeCliRuntime(
    { apiUrl: "https://api.densio.test", json: true },
    {
      environment: {},
      fetch: async (_url, init) => {
        calls.push(init!);
        return new Response("<ProviderResponse/>", { status: 200 });
      },
    },
  );
  await uploadDirectParts(runtime, new Blob(["movie"]), 64 * 1024 * 1024, [
    {
      partNumber: 1,
      bytes: 5,
      method: "PUT",
      url: "https://s3.example.test/bucket/key?signature=fixture",
      expiresAt: "2099-01-01T00:00:00Z",
      headers: { "content-length": "5" },
    },
  ]);
  expect(calls).toHaveLength(1);
  expect(new Headers(calls[0]?.headers).get("authorization")).toBeNull();
  expect(calls[0]).toMatchObject({ method: "PUT", redirect: "error", credentials: "omit" });
  expect(await (calls[0]!.body as Blob).text()).toBe("movie");
});
