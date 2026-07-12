import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { CLI_HELP } from "../src/help.ts";

const commandsReference = fileURLToPath(
  new URL("../../../skills/ffmpeg-api/references/commands.md", import.meta.url),
);

it("keeps every agent-skill flag discoverable in CLI help", async () => {
  const reference = await readFile(commandsReference, "utf8");
  const documentedFlags = new Set(reference.match(/--[a-z][a-z-]*/g) ?? []);

  expect([...documentedFlags].filter((flag) => !CLI_HELP.includes(flag))).toEqual([]);
  expect(reference).toContain("artifacts download 'SIGNED_URL'");
  expect(CLI_HELP).toContain("artifacts download SIGNED_URL");
});
