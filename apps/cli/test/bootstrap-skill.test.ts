import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

const canonicalSkill = new URL("../../../skills/densio/SKILL.md", import.meta.url);
const bootstrapSkill = new URL("../../../skills/densio-bootstrap/SKILL.md", import.meta.url);
const frontmatter = (markdown: string) => markdown.match(/^---\n[\s\S]*?\n---/)?.[0];

it("publishes a stable bootstrap with the canonical activation metadata", async () => {
  const [canonical, bootstrap] = await Promise.all([
    readFile(canonicalSkill, "utf8"),
    readFile(bootstrapSkill, "utf8"),
  ]);
  expect(frontmatter(bootstrap)).toBe(frontmatter(canonical));
  expect(bootstrap).toContain("npx --yes densio@latest --json skill");
  expect(bootstrap).toContain("`data.entrypoint`");
  expect(bootstrap).toContain("`data.files`");
  expect(bootstrap).toContain("only once per invocation");
  expect(bootstrap).toContain("remembered or cached Densio instructions");
});
