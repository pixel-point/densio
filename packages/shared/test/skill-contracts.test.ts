import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SkillBundleSchema } from "../src/index.ts";

const bundle = {
  entrypoint: "SKILL.md",
  files: [
    { content: "# Densio\n", path: "SKILL.md", sha256: "a".repeat(64) },
    {
      content: "# Commands\n",
      path: "references/commands.md",
      sha256: "b".repeat(64),
    },
  ],
  skillVersion: `sha256:${"c".repeat(64)}`,
};

const decode = Schema.decodeUnknownSync(SkillBundleSchema);

describe("skill bundle contract", () => {
  it("accepts a versioned Markdown skill bundle", () => {
    expect(decode(bundle)).toEqual(bundle);
  });

  it.each([
    { ...bundle, files: [{ ...bundle.files[0], path: "../secret.md" }] },
    { ...bundle, files: [{ ...bundle.files[0], sha256: "not-a-hash" }] },
    { ...bundle, files: [{ ...bundle.files[0], content: "" }] },
    { ...bundle, files: [bundle.files[1]] },
    {
      ...bundle,
      files: [bundle.files[0], { ...bundle.files[0], content: "# Duplicate\n" }],
    },
    { ...bundle, skillVersion: "version-1" },
  ])("rejects malformed or unsafe bundle fields", (invalid) => {
    expect(() => decode(invalid)).toThrow();
  });
});
