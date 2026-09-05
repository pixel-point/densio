import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { cleanupCliDirectories, makeCliCapture } from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("organization command safety", () => {
  it.each([
    ["orgs", "delete", "org-1"],
    ["orgs", "delete", "org-1", "--confirm", "org-2"],
    ["orgs", "create", "Team"],
    ["billing", "subscribe", "pro"],
    ["orgs", "get", "org-1", "--org", "org-2"],
    ["capabilities", "--public", "--org", "org-1"],
    ["orgs", "invitations", "create", "person@example.com", "--role", "owner"],
  ])("rejects invalid or ambiguous arguments before network I/O: %j", async (...argv) => {
    const capture = await makeCliCapture();
    const requests: Array<string> = [];
    const exitCode = await runCli([...argv, "--json"], {
      ...capture.dependencies,
      environment: {},
      fetch: async (input) => {
        requests.push(String(input));
        throw new Error("Unexpected network request");
      },
    });
    expect(exitCode).toBe(2);
    expect(capture.stderr()).toContain("CLI_USAGE_ERROR");
    expect(requests).toEqual([]);
  });
});
