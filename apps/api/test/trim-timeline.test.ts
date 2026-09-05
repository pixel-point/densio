import { buildCompressionPlan } from "../src/media/compression-plan.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("resolves presentation frames and EOF using actual variable frame timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-trim-"));
  directories.push(directory);
  await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* MediaProcessRunner;
      const inspector = yield* MediaInspector;
      const inputPath = join(directory, "variable.mkv");
      yield* runner.run({
        executable: "ffmpeg",
        arguments: [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=64x64:rate=10:duration=1",
          "-vf",
          "setpts=PTS+if(gte(N\\,5)\\,0.5/TB\\,0)",
          "-fps_mode",
          "passthrough",
          "-c:v",
          "ffv1",
          inputPath,
        ],
      });
      expect(inspector).toHaveProperty("resolveTrimRange");
      const range = yield* inspector.resolveTrimRange(
        inputPath,
        { start: { kind: "frame", frame: 4 }, end: { kind: "frame", frame: 7 } },
        0,
      );
      expect(range).toMatchObject({
        startFrame: 4,
        endFrame: 7,
        frameCount: 3,
        durationSeconds: 0.8,
        startPts: "400",
        endPts: "1200",
      });
      const outputPath = join(directory, "clip.webm");
      const command = buildCompressionPlan({
        inputPath,
        outputPath,
        codec: "vp9",
        audio: "remove",
        source: { width: 64, height: 64 },
        trim: range,
      });
      yield* runner.run({ executable: command.executable, arguments: command.argv });
      const clip = yield* inspector.resolveTrimRange(
        outputPath,
        { start: { kind: "frame", frame: 0 } },
        0,
      );
      expect(clip).toMatchObject({ frameCount: 3, startPts: "0", durationSeconds: 0.8 });
      const eof = yield* inspector.resolveTrimRange(
        inputPath,
        { start: { kind: "seconds", seconds: 1.05 } },
        0,
      );
      expect(eof).toMatchObject({
        startFrame: 6,
        endFrame: 10,
        frameCount: 4,
        durationSeconds: 0.4,
      });
      const invalid = yield* inspector
        .resolveTrimRange(inputPath, { start: { kind: "frame", frame: 10 } }, 0)
        .pipe(Effect.flip);
      expect(invalid).toMatchObject({ _tag: "TrimRangeInvalid" });
    }).pipe(
      Effect.provide(
        MediaInspector.layer({}).pipe(
          Layer.provideMerge(MediaProcessRunner.layer({ concurrency: 1 })),
        ),
      ),
    ),
  );
});
