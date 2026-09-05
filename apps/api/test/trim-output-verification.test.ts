import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { verifyTrimmedOutputs } from "../src/jobs/trim-output-verification.ts";
import { resolveTrimRange } from "../src/media/inspection/trim-timeline.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import {
  makeJobStoragePaths,
  prepareJobWorkspace,
  resolveStagedFile,
} from "../src/storage/workspace.ts";

it("rejects altered intermediate timing even with equal frame count and total duration", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(`${tmpdir()}/densio-trim-verify-`)),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const paths = yield* makeJobStoragePaths(directory, "job-1");
        yield* prepareJobWorkspace(paths);
        const outputPath = yield* resolveStagedFile(paths, "wrong.mkv");
        const runner = yield* MediaProcessRunner;
        const base = [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=64x64:rate=10:duration=0.4",
          "-vf",
        ];
        const encoding = ["-fps_mode", "passthrough", "-c:v", "ffv1", "-f", "matroska"];
        yield* runner.run({
          executable: "ffmpeg",
          arguments: [
            ...base,
            "setpts=PTS+if(gte(N\\,2)\\,0.2/TB\\,0)",
            ...encoding,
            paths.inputFile,
          ],
        });
        const trim = yield* resolveTrimRange(
          "ffprobe",
          paths.inputFile,
          { start: { kind: "frame", frame: 0 } },
          0,
        );
        yield* runner.run({
          executable: "ffmpeg",
          arguments: [
            ...base,
            "setpts=PTS+if(gte(N\\,1)\\,0.1/TB\\,0)+if(gte(N\\,2)\\,0.1/TB\\,0)",
            ...encoding,
            outputPath,
          ],
        });
        const actual = yield* resolveTrimRange(
          "ffprobe",
          outputPath,
          { start: { kind: "frame", frame: 0 } },
          0,
        );
        expect(actual.frameCount).toBe(trim.frameCount);
        expect(actual.durationSeconds).toBe(trim.durationSeconds);
        const result = yield* verifyTrimmedOutputs(
          "ffprobe",
          paths,
          [
            {
              kind: "video",
              codec: "vp9",
              artifactFilename: "video.webm",
              stagedFilename: "wrong.mkv",
              mediaType: "video/webm",
            },
          ],
          {
            trim,
            codecs: ["vp9"],
            crf: { vp9: 42 },
            audio: "remove",
            frameRate: { mode: "preserve" },
          },
        ).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "TRIM_OUTPUT_INVALID" } });
      }),
    ).pipe(Effect.provide(MediaProcessRunner.layer({ concurrency: 1 }))),
  );
});
