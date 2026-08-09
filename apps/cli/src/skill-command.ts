import { SkillBundleSchema, successEnvelope } from "@densio/shared";
import { Schema } from "effect";

import { CliUsageError } from "./cli-errors.ts";
import { requestJson } from "./http-client.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeSkillEnvelope = Schema.decodeUnknownEffect(successEnvelope(SkillBundleSchema));

export const runSkillCommand = async (
  argumentsInput: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  if (argumentsInput.length > 0) throw new CliUsageError("skill accepts no arguments.");
  const response = await requestJson(runtime, "/v1/skill", { method: "GET" }, decodeSkillEnvelope);
  const humanText = response.data.files
    .map(({ content, path }) => `--- ${path} ---\n${content}`)
    .join("\n");
  emitSuccess(runtime, response, `${humanText}\n`);
};
