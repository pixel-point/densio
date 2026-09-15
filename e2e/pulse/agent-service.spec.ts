import { expect, test } from "@playwright/test";

// This check intentionally targets the production API used by the public Densio CLI.
const apiUrl = "https://api.densio.sh";

test("The agent API and media tools are ready", async ({ request }) => {
  const response = await request.get(`${apiUrl}/ready`, { timeout: 15_000 });
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  expect(payload).toMatchObject({
    status: "ready",
    ffmpegVersion: expect.stringMatching(/\S+/),
    ffprobeVersion: expect.stringMatching(/\S+/),
  });
});

test("An anonymous agent can retrieve the current runtime skill", async ({ request }) => {
  const response = await request.get(`${apiUrl}/v1/skill`, { timeout: 15_000 });
  expect(response.status()).toBe(200);
  const payload: unknown = await response.json();
  expect(payload).toMatchObject({
    ok: true,
    data: {
      entrypoint: "SKILL.md",
      skillVersion: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "SKILL.md",
          content: expect.stringContaining("densio"),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    },
  });
});
