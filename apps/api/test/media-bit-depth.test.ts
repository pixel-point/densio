import { access } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { runCompressionWorkflow } from "../src/media/workflows/compression-workflow.ts";
import { runQualityComparisonWorkflow } from "../src/media/workflows/quality-comparison-workflow.ts";
import {
  cleanupWorkflowTestRoots,
  makeWorkflowTestContext,
  provideWorkflowRunner,
} from "./media-workflow-test-support.ts";

afterEach(cleanupWorkflowTestRoots);

it.each([undefined, 8, 10] as const)(
  "encodes all codecs at requested depth %j from a 10-bit source",
  async (bitDepth) => {
    const { paths } = await makeWorkflowTestContext("bit-depth");
    await Effect.runPromise(
      provideWorkflowRunner(
        Effect.gen(function* () {
          yield* createSource(paths.inputFile, 10);
          const result = yield* runCompressionWorkflow({
            paths,
            source: { width: 64, height: 64 },
            audio: "remove",
            codecs: ["vp9", "h265", "av1"],
            ...(bitDepth === undefined ? {} : { bitDepth }),
          });
          for (const output of result.outputs) {
            const actual = yield* pixelFormat(join(paths.stagingDirectory, output.stagedFilename));
            expect(actual).toBe(bitDepth === 10 ? "yuv420p10le" : "yuv420p");
          }
        }),
      ),
    );
  },
  30000,
);

it("allows an explicit 10-bit encode from an 8-bit source with transforms", async () => {
  const { paths } = await makeWorkflowTestContext("bit-depth");
  await Effect.runPromise(
    provideWorkflowRunner(
      Effect.gen(function* () {
        yield* createSource(paths.inputFile, 8);
        yield* runCompressionWorkflow({
          paths,
          source: { width: 64, height: 64 },
          audio: "remove",
          codecs: ["h265"],
          bitDepth: 10,
          transform: { scale: { width: 32 } },
        });
        expect(yield* pixelFormat(join(paths.stagingDirectory, "compressed-h265.mp4"))).toBe(
          "yuv420p10le",
        );
      }),
    ),
  );
}, 30000);

it.each([8, 10] as const)(
  "compares %i-bit previews against a reference of the same depth",
  async (bitDepth) => {
    const { paths } = await makeWorkflowTestContext("bit-depth");
    await Effect.runPromise(
      provideWorkflowRunner(
        Effect.gen(function* () {
          yield* createSource(paths.inputFile, 10);
          const result = yield* runQualityComparisonWorkflow({
            paths,
            source: { width: 64, height: 64 },
            sourceDurationSeconds: 1,
            resolvedOptions: {
              bitDepth,
              variants: [
                { codec: "vp9", crf: 30 },
                { codec: "h265", crf: 28 },
                { codec: "av1", crf: 30 },
              ],
              objectiveMetrics: ["ssim", "psnr"],
              samples: [
                { sampleId: "sample-1", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 },
              ],
            },
          });
          const expected = bitDepth === 10 ? "yuv420p10le" : "yuv420p";
          const reference = join(paths.stagingDirectory, "quality-reference.mkv");
          expect(yield* pixelFormat(reference)).toBe(expected);
          if (bitDepth === 10)
            expect(yield* frameHash(reference)).toBe(yield* frameHash(paths.inputFile));
          for (const variant of result.variants) {
            expect(
              yield* pixelFormat(join(paths.stagingDirectory, variant.preview.stagedFilename)),
            ).toBe(expected);
            expect(variant.metrics.ssim).toBeGreaterThan(0);
            expect(variant.metrics.psnr).toBeDefined();
          }
        }),
      ),
    );
  },
  30000,
);

it.each(["compress", "compare-quality"] as const)(
  "rejects an encoder returning 8-bit output for a 10-bit %s request",
  async (workflow) => {
    const { paths } = await makeWorkflowTestContext("bit-depth");
    await Effect.runPromise(
      provideWorkflowRunner(
        Effect.gen(function* () {
          yield* createSource(paths.inputFile, 10);
          const runner = yield* MediaProcessRunner;
          const downgradingEncoder = MediaProcessRunner.of({
            run: (command) =>
              runner.run({
                ...command,
                arguments: command.arguments.includes("ffv1")
                  ? command.arguments
                  : command.arguments.map((argument) =>
                      argument === "yuv420p10le" ? "yuv420p" : argument,
                    ),
              }),
          });
          const operation: Effect.Effect<unknown, unknown, MediaProcessRunner> =
            workflow === "compress"
              ? runCompressionWorkflow({
                  paths,
                  source: { width: 64, height: 64 },
                  audio: "remove",
                  codecs: ["vp9"],
                  bitDepth: 10,
                })
              : runQualityComparisonWorkflow({
                  paths,
                  source: { width: 64, height: 64 },
                  sourceDurationSeconds: 1,
                  resolvedOptions: {
                    bitDepth: 10,
                    variants: [
                      { codec: "vp9", crf: 30 },
                      { codec: "vp9", crf: 40 },
                    ],
                    objectiveMetrics: ["ssim"],
                    samples: [
                      {
                        sampleId: "sample-1",
                        normalizedStartSeconds: 0,
                        actualSampleDurationSeconds: 1,
                      },
                    ],
                  },
                });
          const result = yield* operation.pipe(
            Effect.provideService(MediaProcessRunner, downgradingEncoder),
            Effect.result,
          );
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "output-bit-depth-mismatch" },
          });
        }),
      ),
    );
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  },
  30000,
);

const createSource = (path: string, bitDepth: 8 | 10) =>
  MediaProcessRunner.use((runner) =>
    runner.run({
      executable: "ffmpeg",
      arguments: [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        bitDepth === 10
          ? "nullsrc=size=64x64:rate=10:duration=1,format=yuv420p10le,geq=lum='X*4+257':cb=512:cr=512"
          : "testsrc2=size=64x64:rate=10:duration=1",
        "-c:v",
        "ffv1",
        "-f",
        "matroska",
        path,
      ],
    }),
  );

const pixelFormat = (path: string) =>
  MediaProcessRunner.use((runner) =>
    runner
      .run({
        executable: "ffprobe",
        arguments: [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=pix_fmt",
          "-of",
          "json",
          path,
        ],
      })
      .pipe(
        Effect.map(
          (result) =>
            Schema.decodeUnknownSync(
              Schema.fromJsonString(
                Schema.Struct({ streams: Schema.Array(Schema.Struct({ pix_fmt: Schema.String })) }),
              ),
            )(result.stdout).streams[0]?.pix_fmt,
        ),
      ),
  );

const frameHash = (path: string) =>
  MediaProcessRunner.use((runner) =>
    runner
      .run({
        executable: "ffmpeg",
        arguments: [
          "-v",
          "error",
          "-i",
          path,
          "-frames:v",
          "1",
          "-pix_fmt",
          "yuv420p10le",
          "-f",
          "md5",
          "-",
        ],
      })
      .pipe(Effect.map((result) => result.stdout)),
  );
