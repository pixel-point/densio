import {
  JobExecutionReceiptSchema,
  SourceInspectionSchema,
  type JobReceiptStream,
  type SourceInspection,
} from "@densio/shared";
import { Schema } from "effect";
import { artifactFacts } from "../artifacts/artifact-facts.ts";
import type { artifacts, jobs, mediaCommands } from "./schema.ts";

const ToolchainSchema = Schema.Struct({
  ffmpegVersion: Schema.NonEmptyString,
  ffprobeVersion: Schema.NonEmptyString,
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export const buildJobExecutionReceipt = (
  job: typeof jobs.$inferSelect,
  evidence: {
    readonly artifacts: ReadonlyArray<typeof artifacts.$inferSelect>;
    readonly commands: ReadonlyArray<typeof mediaCommands.$inferSelect>;
    readonly actualCreditUnits: number;
  },
) => {
  if (job.completedAt === null) throw new Error("A terminal receipt requires a completion time");
  const inspection = Schema.decodeUnknownSync(Schema.fromJsonString(SourceInspectionSchema))(
    job.inspectionJson,
  );
  const toolchain =
    job.toolchainJson === null
      ? {}
      : Schema.decodeUnknownSync(Schema.fromJsonString(ToolchainSchema))(job.toolchainJson);
  return Schema.decodeUnknownSync(JobExecutionReceiptSchema)({
    organizationId: job.organizationId,
    createdByUserId: job.createdByUserId,
    artifacts: evidence.artifacts.map(artifactFacts),
    billing: {
      actualCreditUnits: evidence.actualCreditUnits,
      actualCredits: evidence.actualCreditUnits / 100,
    },
    execution: {
      attempts: job.attemptCount,
      completedAt: new Date(job.completedAt).toISOString(),
      ...(job.startedAt === null ? {} : { startedAt: new Date(job.startedAt).toISOString() }),
      ...toolchain,
      commands: evidence.commands.map((command) => ({
        executable: command.executable,
        arguments: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
          command.argumentsJson,
        ),
        displayCommand: command.displayCommand,
        startedAt: new Date(command.startedAt).toISOString(),
        ...(command.completedAt === null
          ? {}
          : {
              completedAt: new Date(command.completedAt).toISOString(),
              exitCode: command.exitCode,
            }),
        ...(command.stderrTail === null || command.stderrTail === ""
          ? {}
          : { stderrTail: command.stderrTail }),
      })),
    },
    intent: {
      requestedOptions: decodeJson(job.requestedOptionsJson),
      resolvedOptions: decodeJson(job.resolvedOptionsJson),
      executionPlanId: job.executionPlanId,
      sourceId: job.sourceId,
      intentDigest: job.intentDigest,
      idempotencyKey: job.idempotencyKey,
      ...(job.clientReference === null ? {} : { clientReference: job.clientReference }),
    },
    source: {
      declaredBytes: job.declaredBytes,
      verifiedBytes: job.inputBytes,
      sha256: job.inputSha256,
      filename: job.sourceFilename,
      durationSeconds: inspection.durationSeconds,
      displayHeight: inspection.displayDimensions.height,
      displayWidth: inspection.displayDimensions.width,
      encodedHeight: inspection.encodedDimensions.height,
      encodedWidth: inspection.encodedDimensions.width,
      frameRate: {
        numerator: inspection.frameRate.numerator,
        denominator: inspection.frameRate.denominator,
      },
      rotationDegrees: inspection.rotationDegrees,
      streams: receiptStreams(inspection),
    },
  });
};

const receiptStreams = (inspection: SourceInspection): ReadonlyArray<JobReceiptStream> =>
  inspection.streams.flatMap((stream): ReadonlyArray<JobReceiptStream> => {
    if (stream.type === "unknown" || stream.codec === undefined) return [];
    if (stream.type === "video" && stream.index === inspection.primaryVideoStream.index) {
      return [
        {
          codec: stream.codec,
          durationSeconds: inspection.durationSeconds,
          height: inspection.primaryVideoStream.height,
          index: stream.index,
          kind: stream.type,
          width: inspection.primaryVideoStream.width,
        },
      ];
    }
    const audio = inspection.audioStreams.find(({ index }) => index === stream.index);
    return [
      {
        codec: stream.codec,
        index: stream.index,
        kind: stream.type,
        ...(audio?.channels === undefined ? {} : { channels: audio.channels }),
        ...(audio?.sampleRate === undefined ? {} : { sampleRate: audio.sampleRate }),
      },
    ];
  });
