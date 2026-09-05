import { Schema } from "effect";

import { MaterializedArtifactFileSchema } from "./artifact-contracts.ts";
import { IdentifierSchema } from "./common-contracts.ts";
import { JobStatusSchema } from "./job-status-contracts.ts";

const MaterializedJobSchema = JobStatusSchema.check(
  Schema.makeFilter((job) => {
    if (job.state !== "succeeded") return "A materialization receipt requires a succeeded job";
  }),
);

export const ArtifactMaterializationReceiptSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  jobId: IdentifierSchema,
  job: MaterializedJobSchema,
  outputDirectory: Schema.NonEmptyString,
  files: Schema.Array(MaterializedArtifactFileSchema).check(Schema.isMinLength(1)),
  htmlPath: Schema.optionalKey(Schema.NonEmptyString),
  manifestPath: Schema.optionalKey(Schema.NonEmptyString),
}).check(
  Schema.makeFilter(({ job, jobId, organizationId, files }) => {
    if (job.id !== jobId) return "The materialized job must match the receipt job ID";
    if (
      job.organizationId !== organizationId ||
      files.some((file) => file.organizationId !== organizationId)
    ) {
      return "All materialized files and the job must belong to the receipt organization";
    }
  }),
);
export type ArtifactMaterializationReceipt = typeof ArtifactMaterializationReceiptSchema.Type;
