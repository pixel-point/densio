import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ArtifactMetadataSchema,
  CompressionJobRequestSchema,
  ExtractImagesJobRequestSchema,
  JobResultSchema,
  JobStatusSchema,
  MediaCommandSchema,
  QualityComparisonJobRequestSchema,
  UploadCompletedResponseSchema,
} from "../src/index.ts";

const artifact = {
  id: "artifact-1",
  kind: "video",
  filename: "optimized.webm",
  mediaType: "video/webm",
  bytes: 12_345,
  sha256: "a".repeat(64),
  downloadUrl: "https://media.example.test/v1/artifacts/artifact-1?token=secret",
  expiresAt: "2026-07-12T12:00:00.000Z",
  codec: "vp9",
  width: 1280,
  height: 720,
  durationSeconds: 10,
};

const command = {
  executable: "/opt/ffmpeg/bin/ffmpeg",
  arguments: ["-i", "input.mp4", "-c:v", "libvpx-vp9", "output.webm"],
  displayCommand: "/opt/ffmpeg/bin/ffmpeg -i input.mp4 -c:v libvpx-vp9 output.webm",
  startedAt: "2026-07-11T12:00:00.000Z",
  completedAt: "2026-07-11T12:00:10.000Z",
  exitCode: 0,
};

describe("artifact and command metadata", () => {
  it("accepts downloadable artifacts with integrity and media metadata", () => {
    expect(Schema.decodeUnknownSync(ArtifactMetadataSchema)(artifact)).toEqual(artifact);
  });

  it("rejects unsafe integrity and size metadata", () => {
    const decode = Schema.decodeUnknownSync(ArtifactMetadataSchema);

    expect(() => decode({ ...artifact, sha256: "not-a-digest" })).toThrow();
    expect(() => decode({ ...artifact, bytes: -1 })).toThrow();
  });

  it("preserves the exact executable argument array for debugging", () => {
    expect(Schema.decodeUnknownSync(MediaCommandSchema)(command)).toEqual(command);
  });
});

describe("job results", () => {
  it("accepts compression results with artifacts, HTML, and commands", () => {
    const result = {
      kind: "compress",
      artifacts: [artifact],
      html: '<video controls><source src="optimized.webm" type="video/webm"></video>',
      commands: [command],
    };

    expect(Schema.decodeUnknownSync(JobResultSchema)(result)).toEqual(result);
  });

  it("accepts extraction results", () => {
    const archive = {
      id: artifact.id,
      kind: "image-archive",
      filename: "frames.zip",
      mediaType: "application/zip",
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      downloadUrl: artifact.downloadUrl,
      expiresAt: artifact.expiresAt,
    };
    const result = {
      kind: "extract-images",
      archive,
      imageCount: 10,
      intervalSeconds: 1,
      commands: [command],
    };

    expect(Schema.decodeUnknownSync(JobResultSchema)(result)).toMatchObject({
      kind: "extract-images",
      imageCount: 10,
    });
  });

  it("accepts comparison variants with coarse size estimates", () => {
    const still = { ...artifact, kind: "preview-image", mediaType: "image/jpeg" };
    const result = {
      kind: "compare-quality",
      codec: "vp9",
      normalizedStartSeconds: 60,
      actualSampleDurationSeconds: 1,
      variants: [
        {
          crf: 40,
          preview: { ...artifact, kind: "preview-video" },
          still,
          sampleBytes: 1000,
          estimatedFullVideoBytes: 100_000,
          estimateBasis: "sample-bitrate-extrapolation",
        },
      ],
      commands: [command],
    };

    expect(Schema.decodeUnknownSync(JobResultSchema)(result)).toEqual(result);
  });
});

describe("job status", () => {
  const base = {
    id: "job-1",
    workflow: "compress",
    plan: "free",
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:10.000Z",
  };

  it("accepts every non-terminal state with bounded progress", () => {
    const decode = Schema.decodeUnknownSync(JobStatusSchema);

    for (const state of ["awaiting-upload", "queued", "analyzing", "processing"]) {
      expect(decode({ ...base, state, progressPercent: 50 })).toMatchObject({ state });
    }
  });

  it("requires a result when a job succeeds", () => {
    const decode = Schema.decodeUnknownSync(JobStatusSchema);

    expect(() => decode({ ...base, state: "succeeded", progressPercent: 100 })).toThrow();
    expect(
      decode({
        ...base,
        state: "succeeded",
        progressPercent: 100,
        result: {
          kind: "compress",
          artifacts: [artifact],
          html: "<video></video>",
          commands: [command],
        },
      }),
    ).toMatchObject({ state: "succeeded" });
  });

  it("requires typed problem details when a job fails", () => {
    const decode = Schema.decodeUnknownSync(JobStatusSchema);

    expect(() => decode({ ...base, state: "failed", progressPercent: 50 })).toThrow();
    expect(
      decode({
        ...base,
        state: "failed",
        progressPercent: 50,
        problem: {
          type: "https://ffmpeg-api.example/problems/media-process-failed",
          title: "Media processing failed",
          status: 422,
          detail: "FFmpeg could not encode the input.",
          schemaVersion: 1,
          code: "MEDIA_PROCESS_FAILED",
          retryable: false,
          suggestedAction: "Choose another input or codec.",
          correlationId: "request-1",
          jobId: "job-1",
        },
      }),
    ).toMatchObject({ state: "failed" });
  });
});

describe("job creation and upload", () => {
  const source = { bytes: 1234, filename: "input video.mp4" };

  it("accepts parameter-free compression and typed workflow options", () => {
    expect(Schema.decodeUnknownSync(CompressionJobRequestSchema)({ source })).toEqual({ source });
    expect(
      Schema.decodeUnknownSync(ExtractImagesJobRequestSchema)({
        options: { format: "webp", intervalSeconds: 0.5 },
        source,
      }),
    ).toMatchObject({ options: { format: "webp" } });
    expect(
      Schema.decodeUnknownSync(QualityComparisonJobRequestSchema)({
        options: { codec: "vp9", crfs: [30, 40], position: { kind: "frame", frame: 10 } },
        source,
      }),
    ).toMatchObject({ options: { codec: "vp9" } });
  });

  it("rejects path-shaped source names and missing comparison choices", () => {
    expect(() =>
      Schema.decodeUnknownSync(CompressionJobRequestSchema)({
        source: { bytes: 1, filename: "../input.mp4" },
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(QualityComparisonJobRequestSchema)({ source })).toThrow();
  });

  it("describes a completed streamed upload", () => {
    const response = {
      bytes: 1234,
      jobId: "job-1",
      sha256: "a".repeat(64),
      state: "queued",
    };
    expect(Schema.decodeUnknownSync(UploadCompletedResponseSchema)(response)).toEqual(response);
  });
});
