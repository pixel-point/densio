import type { SkillBundle } from "@densio/shared";
import { expect, it } from "vitest";

import { createSkillRoutes } from "../src/routes/skill.ts";

const bundle: SkillBundle = {
  entrypoint: "SKILL.md",
  files: [{ content: "# Densio\n", path: "SKILL.md", sha256: "a".repeat(64) }],
  skillVersion: `sha256:${"b".repeat(64)}`,
};

it("serves the current skill bundle without allowing a cached response", async () => {
  const routes = createSkillRoutes({
    bundle,
    createCorrelationId: () => "skill-request",
  });

  const response = await routes.request("/v1/skill");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    correlationId: "skill-request",
    data: bundle,
    ok: true,
    schemaVersion: 1,
  });
});
