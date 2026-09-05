import { Effect } from "effect";
import { expect, it } from "vitest";
import { verifyVideoBitDepth } from "../src/media/inspection/video-bit-depth.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";

it.each([
  { stdout: "", stdoutTruncated: false },
  { stdout: "not-json", stdoutTruncated: false },
  { stdout: '{"streams":[]}', stdoutTruncated: false },
  { stdout: '{"streams":[{}]}', stdoutTruncated: false },
  { stdout: '{"streams":[{"pix_fmt":"yuv420p"}]}', stdoutTruncated: false },
  { stdout: '{"streams":[{"pix_fmt":"yuv420p12le"}]}', stdoutTruncated: false },
  { stdout: '{"streams":[{"pix_fmt":"yuv420p10le"}]}', stdoutTruncated: true },
])("rejects missing, truncated, or mismatched bit-depth evidence %j", async (probe) => {
  const result = await Effect.runPromise(
    verifyVideoBitDepth("ffprobe", "/input/output.webm", 10).pipe(
      Effect.provideService(
        MediaProcessRunner,
        MediaProcessRunner.of({
          run: () => Effect.succeed({ ...probe, exitCode: 0, stderrTail: "" }),
        }),
      ),
      Effect.result,
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "output-bit-depth-mismatch" },
  });
});
