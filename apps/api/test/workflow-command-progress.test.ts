import { Effect } from "effect";
import { expect, it } from "vitest";

import { createCommandPlan } from "../src/media/command-plan.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { runWorkflowCommand } from "../src/media/workflows/workflow-command.ts";

it("adds FFmpeg progress protocol flags only for an instrumented workflow command", async () => {
  const observed: Array<unknown> = [];
  const runner = MediaProcessRunner.of({
    run: (command) =>
      Effect.sync(() => {
        observed.push(command);
        return { exitCode: 0, stderrTail: "", stdout: "", stdoutTruncated: false };
      }),
  });
  const plan = createCommandPlan("ffmpeg", ["-i", "input.mp4", "output.webm"]);

  const diagnostic = await Effect.runPromise(
    runWorkflowCommand(plan, {
      codec: "vp9",
      filename: "video-vp9.webm",
      index: 1,
      phase: "encoding",
      total: 1,
      totalDurationSeconds: 10,
    }).pipe(Effect.provideService(MediaProcessRunner, runner)),
  );

  expect(observed).toEqual([
    {
      arguments: ["-nostats", "-progress", "pipe:1", "-i", "input.mp4", "output.webm"],
      executable: "ffmpeg",
      progressContext: {
        codec: "vp9",
        filename: "video-vp9.webm",
        index: 1,
        phase: "encoding",
        total: 1,
        totalDurationSeconds: 10,
      },
    },
  ]);
  expect(diagnostic.arguments).toEqual(
    expect.arrayContaining(["-progress", "pipe:1", "output.webm"]),
  );
  expect(diagnostic.displayCommand).toContain("-progress pipe:1");
});
