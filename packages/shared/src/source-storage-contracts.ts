import { Schema } from "effect";
import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";

export const SourceUploadSessionSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  sourceId: IdentifierSchema,
  connectionId: IdentifierSchema,
  state: Schema.Literals([
    "creating",
    "uploading",
    "committing",
    "preparing",
    "ready",
    "failed",
    "expired",
  ]),
  partSize: Schema.Literal(67_108_864),
  totalParts: PositiveIntegerSchema,
  expiresAt: IsoTimestampSchema,
  uploadedParts: Schema.Array(
    Schema.Struct({ partNumber: PositiveIntegerSchema, bytes: PositiveIntegerSchema }),
  ),
  errorCode: Schema.optionalKey(Schema.String),
});
export const SourceUploadSessionResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  session: SourceUploadSessionSchema,
});
export const SourceUploadPartsRequestSchema = Schema.Struct({
  partNumbers: Schema.Array(PositiveIntegerSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4),
  ),
});
export const SourceUploadPartsResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  sourceId: IdentifierSchema,
  actions: Schema.Array(
    Schema.Struct({
      partNumber: PositiveIntegerSchema,
      bytes: PositiveIntegerSchema,
      method: Schema.Literal("PUT"),
      url: HttpUrlSchema,
      expiresAt: IsoTimestampSchema,
      headers: Schema.Struct({ "content-length": Schema.String }),
    }),
  ),
});
