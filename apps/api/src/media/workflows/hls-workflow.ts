import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedHlsOptions, SourceInspection } from "@densio/shared";
import { Effect } from "effect";
import type { JobStoragePaths } from "../../storage/workspace.ts";
import { resolveStagedFile } from "../../storage/workspace.ts";
import { resolveAudioDecision, type AudioAnalysis } from "../compression-plan.ts";
import { buildHlsCommand } from "../hls-command.ts";
import { finalizeHlsPackage } from "../hls-package.ts";
import { runWorkflowCommand } from "./workflow-command.ts";
import {
  resetWorkflowStaging,
  withWorkflowFailureCleanup,
  workflowFileOperation,
} from "./workflow-staging.ts";
import { createZipArchive } from "./zip-archive.ts";
import { withHlsScratchBudget } from "./hls-scratch.ts";

export const runHlsWorkflow = Effect.fn("HlsWorkflow.run")(function* (input: {
  readonly executable?: string;
  readonly paths: JobStoragePaths;
  readonly packageId: string;
  readonly source: SourceInspection;
  readonly options: ResolvedHlsOptions;
  readonly audioAnalysis: AudioAnalysis;
  readonly maxScratchBytes?: number;
}) {
  return yield* withWorkflowFailureCleanup(
    input.paths,
    Effect.gen(function* () {
      yield* resetWorkflowStaging(input.paths);
      const directory = yield* resolveStagedFile(input.paths, "hls");
      const audio = resolveAudioDecision(input.options.audio, input.audioAnalysis) === "keep";
      yield* workflowFileOperation("prepare-hls-directories", () =>
        Promise.all(
          [...input.options.renditions.map(({ id }) => id), ...(audio ? ["audio"] : [])].map((id) =>
            mkdir(join(directory, id), { recursive: true }),
          ),
        ),
      );
      const command = yield* withHlsScratchBudget(
        input.paths.stagingDirectory,
        input.maxScratchBytes ?? 21474836480,
        runWorkflowCommand(
          buildHlsCommand({ ...input, inputPath: input.paths.inputFile, directory }),
          {
            phase: "encoding",
            index: 1,
            total: 1,
            totalDurationSeconds: input.source.durationSeconds,
            codec: "h265",
          },
        ),
      );
      const contents = yield* finalizeHlsPackage(directory, input.packageId, input.options, audio);
      yield* withHlsScratchBudget(
        input.paths.stagingDirectory,
        input.maxScratchBytes ?? 21474836480,
        createZipArchive(
          yield* resolveStagedFile(input.paths, "hls.zip"),
          contents.members.map((member) => ({
            archiveName: member.path,
            path: join(directory, member.path),
          })),
          { store: true },
        ),
      );
      return {
        directory,
        package: contents,
        commands: [command],
        outputs: [
          {
            kind: "hls-archive" as const,
            codec: "h265" as const,
            artifactFilename: "hls.zip",
            stagedFilename: "hls.zip",
            mediaType: "application/zip",
            durationSeconds: input.source.durationSeconds,
          },
        ],
      };
    }),
  );
});
