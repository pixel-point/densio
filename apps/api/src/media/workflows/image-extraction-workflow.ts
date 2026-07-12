import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ImageFormat, TransformOptions } from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import type { JobStoragePaths } from "../../storage/workspace.ts";
import { resolveStagedFile } from "../../storage/workspace.ts";
import { buildImageExtractionPlan } from "../image-extraction-plan.ts";
import type { VideoDimensions } from "../video-filter.ts";
import { runWorkflowCommand, WorkflowCommandDiagnosticSchema } from "./workflow-command.ts";
import {
  resetWorkflowStaging,
  withWorkflowFailureCleanup,
  workflowFileOperation,
} from "./workflow-staging.ts";
import type { StagedWorkflowOutput, WorkflowCommandDiagnostic } from "./workflow-types.ts";
import { createZipArchive } from "./zip-archive.ts";

export { MediaWorkflowProcessError } from "./workflow-command.ts";

export class MediaWorkflowArchiveError extends Schema.TaggedErrorClass<MediaWorkflowArchiveError>()(
  "MediaWorkflowArchiveError",
  {
    commands: Schema.Array(WorkflowCommandDiagnosticSchema),
    message: Schema.String,
  },
) {}

export class MediaWorkflowOutputError extends Schema.TaggedErrorClass<MediaWorkflowOutputError>()(
  "MediaWorkflowOutputError",
  { message: Schema.String },
) {}

export interface ImageExtractionWorkflowOptions {
  readonly executable?: string;
  readonly format?: ImageFormat;
  readonly intervalSeconds?: number;
  readonly paths: JobStoragePaths;
  readonly source: VideoDimensions;
  readonly sourceDurationSeconds: number;
  readonly transform?: TransformOptions;
}

export interface ExtractedImageManifest {
  readonly format: ImageFormat;
  readonly frames: ReadonlyArray<{
    readonly filename: string;
    readonly timestampSeconds: number;
  }>;
  readonly intervalSeconds: number;
  readonly kind: "extract-images";
  readonly schemaVersion: 1;
  readonly source: VideoDimensions & { readonly durationSeconds: number };
}

export interface ImageExtractionWorkflowResult {
  readonly archive: StagedWorkflowOutput;
  readonly commands: ReadonlyArray<WorkflowCommandDiagnostic>;
  readonly imageCount: number;
  readonly intervalSeconds: number;
  readonly manifest: ExtractedImageManifest;
}

const archiveOutput = {
  artifactFilename: "images.zip",
  kind: "image-archive",
  mediaType: "application/zip",
  stagedFilename: "extracted-images.zip",
} as const satisfies StagedWorkflowOutput;

export const runImageExtractionWorkflow = Effect.fn("MediaWorkflow.runImageExtraction")(function* (
  options: ImageExtractionWorkflowOptions,
) {
  return yield* withWorkflowFailureCleanup(options.paths, executeImageExtractionWorkflow(options));
});

const executeImageExtractionWorkflow = Effect.fn("MediaWorkflow.executeImageExtraction")(function* (
  options: ImageExtractionWorkflowOptions,
) {
  yield* resetWorkflowStaging(options.paths);
  if (!Number.isFinite(options.sourceDurationSeconds) || options.sourceDurationSeconds <= 0) {
    return yield* new MediaWorkflowOutputError({ message: "Source duration must be positive." });
  }

  const format = options.format ?? "jpeg";
  const intervalSeconds = options.intervalSeconds ?? 1;
  const frameDirectory = yield* resolveStagedFile(options.paths, "frames");
  const archivePath = yield* resolveStagedFile(options.paths, archiveOutput.stagedFilename);
  yield* workflowFileOperation("prepare-extraction-frames", () =>
    mkdir(frameDirectory, { recursive: true }),
  );
  const extension = imageExtension(format);
  const plan = buildImageExtractionPlan({
    executable: options.executable ?? "ffmpeg",
    format,
    inputPath: options.paths.inputFile,
    intervalSeconds,
    outputPattern: join(frameDirectory, `frame-%06d.${extension}`),
    source: options.source,
    ...(options.transform === undefined ? {} : { transform: options.transform }),
  });
  const command = yield* runWorkflowCommand(plan);
  const frames = yield* readExtractedFrames(frameDirectory, extension, intervalSeconds);
  if (frames.length === 0) {
    return yield* new MediaWorkflowOutputError({ message: "Image extraction produced no frames." });
  }

  const manifest = extractionManifest(options, format, intervalSeconds, frames);
  const manifestPath = join(frameDirectory, "manifest.json");
  yield* workflowFileOperation("write-extraction-manifest", () =>
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
  );
  yield* createZipArchive(archivePath, [
    ...frames.map((frame) => ({ archiveName: frame.filename, path: frame.path })),
    { archiveName: "manifest.json", path: manifestPath },
  ]).pipe(
    Effect.mapError(
      (error) => new MediaWorkflowArchiveError({ commands: [command], message: error.message }),
    ),
  );
  yield* workflowFileOperation("cleanup-extraction-frames", () =>
    rm(frameDirectory, { force: true, recursive: true }),
  );

  return {
    archive: archiveOutput,
    commands: [command],
    imageCount: frames.length,
    intervalSeconds,
    manifest,
  } satisfies ImageExtractionWorkflowResult;
});

const readExtractedFrames = Effect.fn("MediaWorkflow.readExtractedFrames")(function* (
  directory: string,
  extension: string,
  intervalSeconds: number,
) {
  const entries = yield* workflowFileOperation("list-extracted-frames", () =>
    readdir(directory, { withFileTypes: true }),
  );
  const pattern = new RegExp(`^frame-\\d{6}\\.${extension}$`);

  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .toSorted()
    .map((filename, index) => ({
      filename,
      path: join(directory, filename),
      timestampSeconds: Number((index * intervalSeconds).toFixed(9)),
    }));
});

const extractionManifest = (
  options: ImageExtractionWorkflowOptions,
  format: ImageFormat,
  intervalSeconds: number,
  frames: ReadonlyArray<{ readonly filename: string; readonly timestampSeconds: number }>,
): ExtractedImageManifest => ({
  format,
  frames: frames.map(({ filename, timestampSeconds }) => ({ filename, timestampSeconds })),
  intervalSeconds,
  kind: "extract-images",
  schemaVersion: 1,
  source: { ...options.source, durationSeconds: options.sourceDurationSeconds },
});

const imageExtension = (format: ImageFormat) => {
  if (format === "jpeg") return "jpg";
  return format;
};
