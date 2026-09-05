import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ArtifactDescriptorSchema,
  JobResultSchema,
  JobStatusSchema,
  MediaCommandSchema,
} from "../src/index.ts";
import {
  artifactDescriptor,
  jobBase,
  mediaCommand,
  receipt,
  succeededJob,
} from "./job-fixtures.ts";

describe("stable job results", () => {
  it("keeps integrity metadata in descriptors and exact commands in execution evidence", () => {
    expect(Schema.decodeUnknownSync(ArtifactDescriptorSchema)(artifactDescriptor)).toEqual(
      artifactDescriptor,
    );
    expect(Schema.decodeUnknownSync(MediaCommandSchema)(mediaCommand)).toEqual(mediaCommand);
    expect(() =>
      Schema.decodeUnknownSync(ArtifactDescriptorSchema)({ ...artifactDescriptor, bytes: -1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ArtifactDescriptorSchema)({
        ...artifactDescriptor,
        sha256: "invalid",
      }),
    ).toThrow();
  });

  it("uses stable IDs in compression and extraction outcomes", () => {
    const decode = Schema.decodeUnknownSync(JobResultSchema, { onExcessProperty: "error" });
    expect(decode(succeededJob.result)).toEqual(succeededJob.result);
    const extraction = {
      kind: "extract-images",
      archiveArtifactId: "archive-1",
      imageCount: 10,
      intervalSeconds: 1,
    };
    expect(decode(extraction)).toEqual(extraction);
    expect(() => decode({ ...succeededJob.result, previewHtml: "<video></video>" })).toThrow();
    expect(() => decode({ ...succeededJob.result, artifacts: [artifactDescriptor] })).toThrow();
    expect(() => decode({ ...succeededJob.result, commands: [mediaCommand] })).toThrow();
  });
});

describe("canonical job lifecycle", () => {
  it.each(["preparing", "queued", "analyzing", "processing", "publishing"])(
    "decodes the active %s state with one progress snapshot",
    (state) => {
      const active = {
        ...jobBase,
        state,
        progress: { phase: "preparing", percent: 5, attempt: 0, revision: 1 },
      };
      expect(Schema.decodeUnknownSync(JobStatusSchema)(active)).toEqual(active);
    },
  );

  it.each(["awaiting-upload", "awaiting-decision", "expired"])(
    "rejects retired job state %s",
    (state) => {
      expect(() => Schema.decodeUnknownSync(JobStatusSchema)({ ...succeededJob, state })).toThrow();
    },
  );

  it("requires source, plan, result, receipt, and live inventory for success", () => {
    const decode = Schema.decodeUnknownSync(JobStatusSchema, { onExcessProperty: "error" });
    expect(decode(succeededJob)).toEqual(succeededJob);
    for (const field of [
      "sourceId",
      "executionPlanId",
      "receipt",
      "artifacts",
      "progress",
      "result",
    ] as const) {
      const { [field]: _, ...incomplete } = succeededJob;
      expect(() => decode(incomplete), field).toThrow();
    }
    expect(() => decode({ ...succeededJob, progressPercent: 100 })).toThrow();
    expect(() =>
      decode({ ...succeededJob, progress: { ...succeededJob.progress, percent: 99 } }),
    ).toThrow();
  });

  it("keeps expired artifact availability separate from successful execution", () => {
    const status = {
      ...succeededJob,
      artifacts: [{ ...artifactDescriptor, availability: "expired" }],
    };
    expect(Schema.decodeUnknownSync(JobStatusSchema)(status)).toMatchObject({
      state: "succeeded",
      receipt,
    });
  });

  it("requires honest evidence for never-started cancellation", () => {
    const canceled = {
      ...jobBase,
      state: "canceled",
      progress: { phase: "canceled", percent: 0, attempt: 0, revision: 1 },
      receipt: {
        ...receipt,
        execution: { attempts: 0, completedAt: jobBase.updatedAt, commands: [] },
        billing: { actualCreditUnits: 0, actualCredits: 0 },
        artifacts: [],
      },
    };
    expect(Schema.decodeUnknownSync(JobStatusSchema)(canceled)).toEqual(canceled);
    const { receipt: _, ...withoutEvidence } = canceled;
    expect(() => Schema.decodeUnknownSync(JobStatusSchema)(withoutEvidence)).toThrow();
  });
});
