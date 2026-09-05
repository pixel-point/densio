import { createHash } from "node:crypto";

import { SkillBundleSchema, type SkillBundle, type SkillFile } from "@densio/shared";
import { Schema } from "effect";

import skillMarkdown from "../../../skill-bundle/entrypoint.md?raw";
import commandsMarkdown from "../../../skill-bundle/references/commands.md?raw";
import errorsMarkdown from "../../../skill-bundle/references/errors.md?raw";
import organizationsMarkdown from "../../../skill-bundle/references/organizations.md?raw";
import hlsMarkdown from "../../../skill-bundle/references/hls.md?raw";
import storageMarkdown from "../../../skill-bundle/references/storage.md?raw";
import workflowsMarkdown from "../../../skill-bundle/references/workflows.md?raw";

const decodeSkillBundle = Schema.decodeUnknownSync(SkillBundleSchema);

export const buildSkillBundle = (
  sources: ReadonlyArray<Pick<SkillFile, "content" | "path">>,
): SkillBundle => {
  const files = sources.map(({ content, path }) => ({
    content,
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
  }));
  const bundleHash = files.reduce(
    (hash, { content, path }) => hash.update(path).update("\0").update(content).update("\0"),
    createHash("sha256"),
  );

  return decodeSkillBundle({
    entrypoint: "SKILL.md",
    files,
    skillVersion: `sha256:${bundleHash.digest("hex")}`,
  });
};

export const densioSkillBundle = buildSkillBundle([
  { content: skillMarkdown, path: "SKILL.md" },
  { content: commandsMarkdown, path: "references/commands.md" },
  { content: errorsMarkdown, path: "references/errors.md" },
  { content: organizationsMarkdown, path: "references/organizations.md" },
  { content: hlsMarkdown, path: "references/hls.md" },
  { content: storageMarkdown, path: "references/storage.md" },
  { content: workflowsMarkdown, path: "references/workflows.md" },
]);
