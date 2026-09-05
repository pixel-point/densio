import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ArtifactAuthorizationSchema,
  ArtifactDeletedResponseSchema,
  ArtifactDescriptorSchema,
} from "../src/artifact-contracts.ts";
import { ArtifactMaterializationReceiptSchema } from "../src/materialization-contracts.ts";

import { succeededJob } from "./job-fixtures.ts";

const timestamp = "2026-08-21T12:00:00.000Z";
const descriptor = {
  organizationId: "org-1",
  authorizeUrl: "https://api.densio.test/v1/artifacts/artifact-1/authorize",
  availability: "available",
  bytes: 12_345,
  codec: "vp9",
  deleteUrl: "https://api.densio.test/v1/artifacts/artifact-1",
  durationSeconds: 10,
  filename: "homepage-hero.webm",
  height: 720,
  id: "artifact-1",
  kind: "video",
  mediaType: "video/webm",
  retainedUntil: timestamp,
  sha256: "a".repeat(64),
  width: 1280,
};

describe("stable artifacts", () => {
  it("decodes a stable descriptor without embedding a bearer download URL", () => {
    expect(Schema.decodeUnknownSync(ArtifactDescriptorSchema)(descriptor)).toEqual(descriptor);
  });

  it("keeps independent authorization separate from physical retention", () => {
    const authorization = {
      organizationId: "org-1",
      artifact: descriptor,
      download: {
        expiresAt: "2026-08-14T12:05:00.000Z",
        method: "GET",
        url: "https://api.densio.test/v1/artifacts/artifact-1/download?token=secret",
      },
    };

    expect(Schema.decodeUnknownSync(ArtifactAuthorizationSchema)(authorization)).toEqual(
      authorization,
    );
  });

  it("decodes idempotent deletion and verified materialization receipts", () => {
    const deletion = {
      organizationId: "org-1",
      artifactId: "artifact-1",
      deleted: true,
      deletedAt: timestamp,
    };
    const job = { ...succeededJob, artifacts: [descriptor] };
    const materialization = {
      organizationId: "org-1",
      files: [
        {
          artifactId: "artifact-1",
          organizationId: "org-1",
          bytes: 12_345,
          filename: "homepage-hero.webm",
          path: "/tmp/site/public/homepage-hero.webm",
          sha256: "a".repeat(64),
          verified: true,
        },
      ],
      htmlPath: "/tmp/site/public/index.html",
      job,
      jobId: "job-1",
      manifestPath: "/tmp/site/public/densio-manifest.json",
      outputDirectory: "/tmp/site/public",
    };

    expect(Schema.decodeUnknownSync(ArtifactDeletedResponseSchema)(deletion)).toEqual(deletion);
    expect(Schema.decodeUnknownSync(ArtifactMaterializationReceiptSchema)(materialization)).toEqual(
      materialization,
    );
  });
});
