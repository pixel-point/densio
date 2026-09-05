import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { buildCompressionPlan } from "../src/media/compression-plan.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";

it.each(["vp9", "h265", "av1"] as const)(
  "keeps exact source pictures and delayed audio when trimming to %s",
  async (codec) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "densio-trim-audio-"))),
            (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
          );
          const runner = yield* MediaProcessRunner;
          const inspector = yield* MediaInspector;
          const inputPath = join(directory, "source.mkv");
          yield* createSource(inputPath);
          const range = yield* inspector.resolveTrimRange(
            inputPath,
            { start: { kind: "frame", frame: 3 }, end: { kind: "frame", frame: 8 } },
            0,
          );
          expect(range).toMatchObject({ startPts: "2300", endPts: "2800", durationSeconds: 0.5 });
          const outputPath = join(directory, codec === "h265" ? "clip.mp4" : "clip.webm");
          const command = buildCompressionPlan({
            inputPath,
            outputPath,
            source: { width: 64, height: 64 },
            codec,
            audio: "keep",
            trim: range,
            audioStreamIndex: 1,
          });
          yield* runner.run({ executable: command.executable, arguments: command.argv });
          const output = yield* inspector.inspect(outputPath);
          const video = yield* inspector.resolveTrimRange(
            outputPath,
            { start: { kind: "frame", frame: 0 } },
            output.videoStreamIndex,
          );
          expect(video.frameCount).toBe(5);
          const offset =
            output.streams.find((stream) => stream.type === "audio")!.startTimeSeconds! -
            (Number(video.startPts) * video.timeBase.numerator) / video.timeBase.denominator;
          expect(offset).toBeCloseTo(0.35, 1);
          const rawPath = join(directory, "pictures.raw");
          yield* runner.run({
            executable: "ffmpeg",
            arguments: [
              "-v",
              "error",
              "-i",
              outputPath,
              "-map",
              "0:v:0",
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
          const frameBytes = (64 * 64 * 3) / 2;
          expect(bytes.length).toBe(frameBytes * 5);
          expect(Math.abs(bytes[0]! - 44)).toBeLessThanOrEqual(3);
          expect(Math.abs(bytes[frameBytes * 4]! - 76)).toBeLessThanOrEqual(3);
        }),
      ).pipe(
        Effect.provide(
          MediaInspector.layer({}).pipe(
            Layer.provideMerge(MediaProcessRunner.layer({ concurrency: 1 })),
          ),
        ),
      ),
    );
  },
);

const createSource = Effect.fn("TrimTest.audioSource")(function* (path: string) {
  const runner = yield* MediaProcessRunner;
  yield* runner.run({
    executable: "ffmpeg",
    arguments: [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=size=64x64:rate=10:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=0.35",
      "-filter_complex",
      "[0:v]geq=lum='20+N*8':cb=128:cr=128,setpts=PTS+2/TB[v];[1:a]asetpts=PTS+2.65/TB[a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "ffv1",
      "-c:a",
      "pcm_s16le",
      path,
    ],
  });
});

it("treats audio that starts after the selected interval as silent for automatic compression", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "densio-trim-silent-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const inspector = yield* MediaInspector;
        const path = join(directory, "source.mkv");
        yield* createSource(path);
        const trim = yield* inspector.resolveTrimRange(
          path,
          { start: { kind: "frame", frame: 0 }, end: { kind: "frame", frame: 3 } },
          0,
        );
        expect(yield* inspector.classifyAudio(path, [1], trim)).toBe("silent");
        expect(yield* inspector.classifyAudio(path, [1])).toBe("audible");
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
