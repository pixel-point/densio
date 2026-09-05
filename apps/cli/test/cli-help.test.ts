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
    expect(capture.stdout()).toContain("https://api.densio.sh");
    expect(capture.stdout()).not.toContain(["ffmpeg", "api"].join("-"));
    [
      "auth login EMAIL",
      "auth status",
      "auth logout",
      "inspect VIDEO",
      "sources list",
      "sources get SOURCE_ID",
      "sources delete SOURCE_ID",
      "plans create SOURCE_ID compress",
      "plans create SOURCE_ID extract-images",
      "plans create SOURCE_ID compare-quality",
      "plans resolve PLAN_ID",
      "plans execute PLAN_ID",
      "jobs list",
      "jobs lookup",
      "jobs events JOB_ID",
      "jobs watch JOB_ID",
      "jobs get JOB_ID",
      "jobs wait JOB_ID",
      "jobs cancel JOB_ID",
      "artifacts download ARTIFACT_ID",
      "artifacts materialize JOB_ID",
      "billing status",
      "billing subscribe PLAN",
      "billing portal",
      "--output-dir DIR",
      "--matrix CODEC:CRF,CRF",
      "--samples N",
      "--sample SECONDS|TIMECODE|frame:N",
      "--metric ssim,psnr",
      "--max-credits N",
      "--max-output-bytes N",
    ].forEach((command) => expect(capture.stdout()).toContain(command));
    expect(capture.stdout()).not.toContain("SIGNED_URL");
    expect(capture.stdout()).not.toContain("decide-frame-rate");
    const examples = capture.stdout().split("Examples:\n")[1]?.trim().split("\n") ?? [];
    expect(examples.length).toBeGreaterThan(0);
    examples
      .filter((line) => !line.includes("orgs list"))
      .forEach((line) => expect(line).toContain("--org ORG_ID"));
    expect(capture.stderr()).toBe("");
  });
});

describe("CLI usage errors", () => {
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
