import { Schema } from "effect";

import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  SafePathComponentSchema,
  Sha256Schema,
} from "./common-contracts.ts";
import { ProblemDetailsSchema } from "./problem-details.ts";

export const PreparedSourceCreateRequestSchema = Schema.Struct({
  filename: SafePathComponentSchema,
  bytes: PositiveIntegerSchema,
  uploadStorage: Schema.optionalKey(IdentifierSchema),
});
export type PreparedSourceCreateRequest = typeof PreparedSourceCreateRequestSchema.Type;

const LocalSourceActionSchema = Schema.Struct({
  method: Schema.Literal("PUT"),
  url: HttpUrlSchema,
  expiresAt: IsoTimestampSchema,
});
export const SourceActionSchema = Schema.Union([
  LocalSourceActionSchema,
  Schema.Struct({
    method: Schema.Literal("POST"),
    transport: Schema.Literal("s3-multipart"),
    url: HttpUrlSchema,
    expiresAt: IsoTimestampSchema,
  }),
]);
export type SourceAction = typeof SourceActionSchema.Type;

export const SourceDimensionsSchema = Schema.Struct({
  width: PositiveIntegerSchema,
  height: PositiveIntegerSchema,
});
export type SourceDimensions = typeof SourceDimensionsSchema.Type;

export const SourceFrameRateSchema = Schema.Struct({
  numerator: PositiveIntegerSchema,
  denominator: PositiveIntegerSchema,
  framesPerSecond: PositiveFiniteSchema,
});
export type SourceFrameRate = typeof SourceFrameRateSchema.Type;

export const SourceStreamTypeSchema = Schema.Literals([
  "video",
  "audio",
  "subtitle",
  "data",
  "attachment",
  "unknown",
]);
export type SourceStreamType = typeof SourceStreamTypeSchema.Type;

export const SourceStreamSchema = Schema.Struct({
  index: NonNegativeIntegerSchema,
  type: SourceStreamTypeSchema,
  codec: Schema.optionalKey(Schema.NonEmptyString),
});
export type SourceStream = typeof SourceStreamSchema.Type;

export const SourceVideoStreamSchema = Schema.Struct({
  index: NonNegativeIntegerSchema,
  type: Schema.Literal("video"),
  codec: Schema.NonEmptyString,
  width: PositiveIntegerSchema,
  height: PositiveIntegerSchema,
});
export type SourceVideoStream = typeof SourceVideoStreamSchema.Type;

export const SourceAudioStreamSchema = Schema.Struct({
  index: NonNegativeIntegerSchema,
  type: Schema.Literal("audio"),
  codec: Schema.NonEmptyString,
  channels: Schema.optionalKey(PositiveIntegerSchema),
  sampleRate: Schema.optionalKey(PositiveIntegerSchema),
  startTimeSeconds: Schema.optionalKey(Schema.Finite),
});
export type SourceAudioStream = typeof SourceAudioStreamSchema.Type;

export const SourceVideoPropertiesSchema = Schema.Struct({
  pixelFormat: Schema.NonEmptyString,
  sampleAspectRatio: Schema.Struct({
    numerator: PositiveIntegerSchema,
    denominator: PositiveIntegerSchema,
  }),
  fieldOrder: Schema.NonEmptyString,
  colorPrimaries: Schema.optionalKey(Schema.NonEmptyString),
  colorTransfer: Schema.optionalKey(Schema.NonEmptyString),
  colorSpace: Schema.optionalKey(Schema.NonEmptyString),
  colorRange: Schema.optionalKey(Schema.NonEmptyString),
  startTimeSeconds: Schema.optionalKey(Schema.Finite),
});
export type SourceVideoProperties = typeof SourceVideoPropertiesSchema.Type;

export const SourceInspectionSchema = Schema.Struct({
  videoProperties: Schema.optionalKey(SourceVideoPropertiesSchema),
  durationSeconds: PositiveFiniteSchema,
  encodedDimensions: SourceDimensionsSchema,
  displayDimensions: SourceDimensionsSchema,
  rotationDegrees: Schema.Literals([0, 90, 180, 270]),
  frameRate: SourceFrameRateSchema,
  primaryVideoStream: SourceVideoStreamSchema,
  audioStreams: Schema.Array(SourceAudioStreamSchema),
  streams: Schema.Array(SourceStreamSchema).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(({ audioStreams, primaryVideoStream, streams }) => {
    const indexes = streams.map(({ index }) => index);
    if (new Set(indexes).size !== indexes.length) return "Source stream indexes must be unique";
    if (
      !streams.some(
        ({ codec, index, type }) =>
          index === primaryVideoStream.index &&
          type === "video" &&
          codec === primaryVideoStream.codec,
      )
    ) {
      return "Primary video stream must be present in the stream inventory";
    }
    if (
      audioStreams.some(
        (audio) =>
          !streams.some(
            ({ codec, index, type }) =>
              index === audio.index && type === "audio" && codec === audio.codec,
          ),
      )
    ) {
      return "Audio stream details must be present in the stream inventory";
    }
  }),
);
export type SourceInspection = typeof SourceInspectionSchema.Type;

const PreparedSourceBaseFields = {
  organizationId: IdentifierSchema,
  createdByUserId: IdentifierSchema,
  sourceId: IdentifierSchema,
  filename: SafePathComponentSchema,
  declaredBytes: PositiveIntegerSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
};

export const AwaitingUploadPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("awaiting-upload"),
  upload: SourceActionSchema,
});
export type AwaitingUploadPreparedSourceStatus =
  typeof AwaitingUploadPreparedSourceStatusSchema.Type;

export const InspectingPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("inspecting"),
  verifiedBytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
  upload: Schema.optionalKey(Schema.Never),
});
export type InspectingPreparedSourceStatus = typeof InspectingPreparedSourceStatusSchema.Type;

export const ReadyPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("ready"),
  verifiedBytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
  inspection: SourceInspectionSchema,
  upload: Schema.optionalKey(Schema.Never),
});
export type ReadyPreparedSourceStatus = typeof ReadyPreparedSourceStatusSchema.Type;

export const FailedPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("failed"),
  verifiedBytes: Schema.optionalKey(PositiveIntegerSchema),
  sha256: Schema.optionalKey(Sha256Schema),
  problem: ProblemDetailsSchema,
  upload: Schema.optionalKey(Schema.Never),
});
export type FailedPreparedSourceStatus = typeof FailedPreparedSourceStatusSchema.Type;

export const ExpiredPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("expired"),
  verifiedBytes: Schema.optionalKey(PositiveIntegerSchema),
  sha256: Schema.optionalKey(Sha256Schema),
  upload: Schema.optionalKey(Schema.Never),
});
export type ExpiredPreparedSourceStatus = typeof ExpiredPreparedSourceStatusSchema.Type;

export const FinalizingPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("finalizing"),
  verifiedBytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
});
export type FinalizingPreparedSourceStatus = typeof FinalizingPreparedSourceStatusSchema.Type;

export const DeletedPreparedSourceStatusSchema = Schema.Struct({
  ...PreparedSourceBaseFields,
  state: Schema.Literal("deleted"),
  verifiedBytes: Schema.optionalKey(PositiveIntegerSchema),
  sha256: Schema.optionalKey(Sha256Schema),
});
export type DeletedPreparedSourceStatus = typeof DeletedPreparedSourceStatusSchema.Type;

export const PreparedSourceStatusSchema = Schema.Union([
  AwaitingUploadPreparedSourceStatusSchema,
  FinalizingPreparedSourceStatusSchema,
  DeletedPreparedSourceStatusSchema,
  InspectingPreparedSourceStatusSchema,
  ReadyPreparedSourceStatusSchema,
  FailedPreparedSourceStatusSchema,
  ExpiredPreparedSourceStatusSchema,
]);
export type PreparedSourceStatus = typeof PreparedSourceStatusSchema.Type;

export const PreparedSourceCreateResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  replayed: Schema.Boolean,
  source: PreparedSourceStatusSchema,
});
export type PreparedSourceCreateResponse = typeof PreparedSourceCreateResponseSchema.Type;

export const PreparedSourceDeletionReceiptSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  sourceId: IdentifierSchema,
  state: Schema.Literal("deleted"),
  deletedAt: IsoTimestampSchema,
});
export type PreparedSourceDeletionReceipt = typeof PreparedSourceDeletionReceiptSchema.Type;

export const PreparedSourceStateSchema = Schema.Literals([
  "awaiting-upload",
  "finalizing",
  "inspecting",
  "ready",
  "failed",
  "deleted",
  "expired",
]);
export type PreparedSourceState = typeof PreparedSourceStateSchema.Type;

export const PreparedSourceListQuerySchema = Schema.Struct({
  state: Schema.optionalKey(PreparedSourceStateSchema),
  since: Schema.optionalKey(IsoTimestampSchema),
  limit: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type PreparedSourceListQuery = typeof PreparedSourceListQuerySchema.Type;

export const PreparedSourceListResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  sources: Schema.Array(PreparedSourceStatusSchema),
  nextCursor: Schema.optionalKey(Schema.NonEmptyString),
});
export type PreparedSourceListResponse = typeof PreparedSourceListResponseSchema.Type;
