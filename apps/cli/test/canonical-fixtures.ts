import type {
  ArtifactDescriptor,
  ArtifactReceipt,
  JobExecutionReceipt,
  JobStatus,
} from "@densio/shared";

export const timestamp = "2026-07-11T12:00:00.000Z";
export const jobBase = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  id: "job-1",
  sourceId: "source-1",
  executionPlanId: "plan-1",
  workflow: "compress",
  plan: "free",
  createdAt: timestamp,
  updatedAt: timestamp,
  actions: [],
} as const;

export const executionReceipt = (
  outputs: ReadonlyArray<ArtifactReceipt> = [],
): JobExecutionReceipt => ({
  organizationId: "org-1",
  createdByUserId: "user-1",
  source: {
    filename: "source.mp4",
    declaredBytes: 100,
    verifiedBytes: 100,
    sha256: "b".repeat(64),
    durationSeconds: 10,
    encodedWidth: 640,
    encodedHeight: 360,
    displayWidth: 640,
    displayHeight: 360,
    rotationDegrees: 0,
    frameRate: { numerator: 30, denominator: 1 },
    streams: [{ index: 0, kind: "video", codec: "h264" }],
  },
  intent: {
    requestedOptions: {},
    resolvedOptions: {
      codecs: ["vp9"],
      crf: { vp9: 42 },
      audio: "auto",
      frameRate: { mode: "preserve" },
    },
    sourceId: "source-1",
    executionPlanId: "plan-1",
    intentDigest: "c".repeat(64),
    idempotencyKey: "execute-1",
  },
  execution: {
    attempts: 1,
    startedAt: timestamp,
    completedAt: timestamp,
    ffmpegVersion: "test",
    ffprobeVersion: "test",
    commands: [],
  },
  billing: { actualCreditUnits: 5, actualCredits: 0.05 },
  artifacts: outputs.map((artifact) => ({
    organizationId: artifact.organizationId,
    id: artifact.id,
    kind: artifact.kind,
    filename: artifact.filename,
    mediaType: artifact.mediaType,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    retainedUntil: artifact.retainedUntil,
  })),
});

export const activeJob = {
  ...jobBase,
  state: "processing",
  progress: { phase: "encoding", percent: 40, attempt: 1, revision: 2 },
} satisfies JobStatus;

export const canceledJob = {
  ...jobBase,
  state: "canceled",
  progress: { phase: "canceled", percent: 40, attempt: 1, revision: 3 },
  receipt: executionReceipt(),
  problem: {
    code: "JOB_CANCELED",
    correlationId: "test-correlation",
    detail: "Canceled for the test.",
    jobId: "job-1",
    retryable: false,
    schemaVersion: 1,
    status: 409,
    suggestedAction: "Create another execution.",
    title: "Canceled",
    type: "about:blank",
  },
} satisfies JobStatus;

export const successfulCompressionJob = (outputs: ReadonlyArray<ArtifactDescriptor>) =>
  ({
    ...jobBase,
    state: "succeeded" as const,
    artifacts: outputs,
    receipt: executionReceipt(outputs),
    progress: { phase: "complete" as const, percent: 100, attempt: 1, revision: 3 },
    result: {
      kind: "compress" as const,
      artifactIds: outputs.map(({ id }) => id),
      html: "<video></video>",
    },
  }) satisfies JobStatus;
