import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { cleanupCliDirectories, makeCliCapture } from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("CLI help", () => {
  it("documents the complete agent-first command surface", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(["--help"], capture.dependencies);

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toContain("densio — agent-first video processing");
    expect(capture.stdout()).toContain("DENSIO_API_URL");
    expect(capture.stdout()).not.toContain(["ffmpeg", "api"].join("-"));
    expect(capture.stdout()).toContain("auth login|status|logout");
    expect(capture.stdout()).toContain("compress <video>");
    expect(capture.stdout()).toContain("extract-images <video>");
    expect(capture.stdout()).toContain("compare-quality <video>");
    expect(capture.stdout()).toContain("jobs get|wait|cancel");
    expect(capture.stdout()).toContain("artifacts download");
    expect(capture.stdout()).toContain("billing subscribe PLAN|portal");
    expect(capture.stdout()).toContain("capabilities");
    expect(capture.stderr()).toBe("");
  });

  it("returns a stable JSON usage problem without prompts", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(["--json", "compress"], capture.dependencies);

    expect(exitCode).toBe(2);
    expect(capture.stdout()).toBe("");
    expect(JSON.parse(capture.stderr())).toMatchObject({
      code: "CLI_USAGE_ERROR",
      schemaVersion: 1,
      status: 400,
    });
  });

  it("formats malformed global flags instead of rejecting the process", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(["--json", "--api-url"], capture.dependencies);

    expect(exitCode).toBe(2);
    expect(capture.stdout()).toBe("");
    expect(JSON.parse(capture.stderr()).code).toBe("CLI_USAGE_ERROR");
  });

  it("rejects a non-HTTP API URL as usage", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(
      ["--json", "--api-url", "file:///tmp/api", "capabilities"],
      capture.dependencies,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.stderr()).code).toBe("CLI_USAGE_ERROR");
  });

  it("formats an invalid environment URL without rejecting", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(["--json", "capabilities"], {
      ...capture.dependencies,
      environment: { DENSIO_API_URL: "file:///tmp/api" },
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.stderr()).code).toBe("CLI_USAGE_ERROR");
  });
});
