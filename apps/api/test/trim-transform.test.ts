import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { buildCompressionPlan } from "../src/media/compression-plan.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";

it("selects presentation frames from a B-frame source before resizing and capping cadence", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "densio-trim-transform-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const runner = yield* MediaProcessRunner;
        const inspector = yield* MediaInspector;
        const inputPath = join(directory, "source.mp4");
        yield* createSource(inputPath);
        const pictures = yield* runner.run({
          executable: "ffprobe",
          arguments: [
            "-v",
            "error",
            "-show_entries",
            "frame=pict_type",
            "-of",
            "csv=p=0",
            inputPath,
          ],
        });
        expect(pictures.stdout).toContain("B");
        const trim = yield* inspector.resolveTrimRange(
          inputPath,
          { start: { kind: "frame", frame: 60 }, end: { kind: "frame", frame: 120 } },
          0,
        );
        expect(trim).toMatchObject({ frameCount: 60, durationSeconds: 1 });
        const outputPath = join(directory, "clip.webm");
        const command = buildCompressionPlan({
          inputPath,
          outputPath,
          source: { width: 64, height: 64 },
          sourceFrameRate: { numerator: 60, denominator: 1 },
          frameRate: { mode: "cap", maximum: 30 },
          transform: { scale: { width: 32 } },
          trim,
          codec: "vp9",
          audio: "remove",
        });
        yield* runner.run({ executable: command.executable, arguments: command.argv });
        const output = yield* inspector.inspect(outputPath);
        expect(output.displayDimensions).toEqual({ width: 32, height: 32 });
        const clip = yield* inspector.resolveTrimRange(
          outputPath,
          { start: { kind: "frame", frame: 0 } },
          output.videoStreamIndex,
        );
        expect(clip.frameCount).toBe(30);
        expect(clip.durationSeconds).toBeCloseTo(1, 2);
        const rawPath = join(directory, "frames.raw");
        yield* runner.run({
          executable: "ffmpeg",
          arguments: [
            "-v",
            "error",
            "-i",
            outputPath,
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rawvideo",
            rawPath,
          ],
        });
        const bytes = yield* Effect.promise(() => readFile(rawPath));
        const frameBytes = (32 * 32 * 3) / 2;
        expect(bytes.length).toBe(frameBytes * 30);
        expect(bytes[0]).toBeGreaterThanOrEqual(108);
        expect(bytes[0]).toBeLessThanOrEqual(114);
        expect(bytes[29 * frameBytes]).toBeGreaterThanOrEqual(195);
        expect(bytes[29 * frameBytes]).toBeLessThanOrEqual(201);
      }),
    ).pipe(
      Effect.provide(
        MediaInspector.layer({}).pipe(
          Layer.provideMerge(MediaProcessRunner.layer({ concurrency: 1 })),
        ),
      ),
    ),
  );
});

const createSource = Effect.fn("TrimTest.bFrameSource")(function* (path: string) {
  const runner = yield* MediaProcessRunner;
  yield* runner.run({
    executable: "ffmpeg",
    arguments: [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=64x64:rate=60:duration=2",
      "-vf",
      "geq=lum='20+N*1.5':cb=128:cr=128",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      "lossless=1:bframes=3",
      path,
    ],
  });
});
