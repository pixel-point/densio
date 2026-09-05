import {
  SkillBundleSchema,
  SkillFilePathSchema,
  SkillSelectionSchema,
  SkillVersionSchema,
  successEnvelope,
} from "@densio/shared";
import { Schema } from "effect";
import { version } from "../package.json";

import { CliUsageError, skillVersionChangedError } from "./cli-errors.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { decodeCliOptions, singleFlag } from "./command-options.ts";
import { requestJson } from "./http-client.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeSkillEnvelope = Schema.decodeUnknownEffect(successEnvelope(SkillBundleSchema));
const decodeSelection = Schema.decodeUnknownSync(SkillSelectionSchema);

export const runSkillCommand = async (
  argumentsInput: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const parsed = parseCatalogCommand("skill", argumentsInput);
  if (parsed.positionals.length > 1)
    throw new CliUsageError("skill accepts at most one path: SKILL.md or references/NAME.md.");
  const requestedPath = decodeCliOptions(
    SkillFilePathSchema,
    parsed.positionals[0] ?? "SKILL.md",
    "skill",
  );
  const expectedVersion = singleFlag(parsed, "--skill-version");
  if (expectedVersion !== undefined) decodeCliOptions(SkillVersionSchema, expectedVersion, "skill");
  const response = await requestJson(runtime, "/v1/skill", { method: "GET" }, decodeSkillEnvelope);
  if (expectedVersion !== undefined && expectedVersion !== response.data.skillVersion)
    throw skillVersionChangedError();
  const file = response.data.files.find((candidate) => candidate.path === requestedPath);
  if (file === undefined)
    throw new CliUsageError(
      `${requestedPath} is not in the current skill. Run skill to list references.`,
    );
  const data = decodeSelection({
    cliVersion: version,
    entrypoint: response.data.entrypoint,
    files: [file],
    references: response.data.files
      .filter((candidate) => candidate.path !== response.data.entrypoint)
      .map(({ path, sha256 }) => ({ path, sha256 })),
    skillVersion: response.data.skillVersion,
  });
  const humanText = [
    `CLI: npx --yes densio@${version}; skillVersion: ${data.skillVersion}`,
    `--- ${file.path} ---\n${file.content}`,
    `References: ${data.references.map(({ path }) => path).join(", ")}`,
    "",
  ].join("\n");
  emitSuccess(runtime, { ...response, data }, humanText);
};
