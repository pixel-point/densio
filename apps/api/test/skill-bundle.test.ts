import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { buildSkillBundle, densioSkillBundle } from "../src/skill-bundle.ts";

const skillDirectory = new URL("../../../skill-bundle/", import.meta.url);
const expectedSources = [
  ["SKILL.md", "entrypoint.md"],
  ["references/commands.md", "references/commands.md"],
  ["references/errors.md", "references/errors.md"],
  ["references/organizations.md", "references/organizations.md"],
  ["references/hls.md", "references/hls.md"],
  ["references/storage.md", "references/storage.md"],
  ["references/workflows.md", "references/workflows.md"],
] as const;

it("embeds the canonical repository skill and references byte-for-byte", async () => {
  const expectedEntries = await Promise.all(
    expectedSources.map(
      async ([path, sourcePath]) =>
        [path, await readFile(new URL(sourcePath, skillDirectory), "utf8")] as const,
    ),
  );
  const expected = Object.fromEntries(expectedEntries);
  const files = Object.fromEntries(
    densioSkillBundle.files.map(({ content, path }) => [path, content]),
  );

  expect(densioSkillBundle.entrypoint).toBe("SKILL.md");
  expect(files).toEqual(expected);
  expect(densioSkillBundle.files.map(({ sha256 }) => sha256)).toEqual(
    expectedEntries.map(([, content]) => createHash("sha256").update(content).digest("hex")),
  );
});

it("derives the bundle version from ordered paths and contents", () => {
  const first = buildSkillBundle([{ content: "one", path: "SKILL.md" }]);
  const same = buildSkillBundle([{ content: "one", path: "SKILL.md" }]);
  const changed = buildSkillBundle([{ content: "two", path: "SKILL.md" }]);

  expect(first.skillVersion).toBe(same.skillVersion);
  expect(first.skillVersion).not.toBe(changed.skillVersion);
});

it("includes the canonical skill bundle in the Docker build context", async () => {
  const dockerIgnore = await readFile(new URL("../../../.dockerignore", import.meta.url), "utf8");

  expect(dockerIgnore).toContain("!skill-bundle/**");
});
