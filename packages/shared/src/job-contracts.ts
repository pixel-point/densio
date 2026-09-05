import { Schema } from "effect";

const PrintableCorrelationValueSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) => {
    const hasControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    });
    if (hasControlCharacter) return "Correlation values must contain only printable characters";
  }),
);

export const ClientReferenceSchema = PrintableCorrelationValueSchema;
export type ClientReference = typeof ClientReferenceSchema.Type;

export const JobIdempotencyKeySchema = PrintableCorrelationValueSchema;
export type JobIdempotencyKey = typeof JobIdempotencyKeySchema.Type;

export const JobWorkflowSchema = Schema.Literals([
  "compress",
  "trim",
  "extract-images",
  "compare-quality",
  "hls",
]);
export type JobWorkflow = typeof JobWorkflowSchema.Type;

export const JobStateSchema = Schema.Literals([
  "preparing",
  "queued",
  "analyzing",
  "processing",
  "publishing",
  "succeeded",
  "failed",
  "canceled",
]);
export type JobState = typeof JobStateSchema.Type;
