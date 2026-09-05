import type { JobExecutionReceipt, JobStatus } from "../src/index.ts";

export const timestamp = "2026-08-14T12:00:00.000Z";
export const artifactFacts = {
  organizationId: "org-1",
  id: "artifact-1",
  kind: "video",
  filename: "homepage-hero.webm",
  mediaType: "video/webm",
  bytes: 12_345,
  sha256: "a".repeat(64),
  retainedUntil: "2026-08-21T12:00:00.000Z",
  codec: "vp9",
  width: 1280,
  height: 720,
  durationSeconds: 10,
} as const;
export const artifactDescriptor = {
  ...artifactFacts,
  availability: "available",
  authorizeUrl: "https://api.densio.test/v1/artifacts/artifact-1/authorize",
  deleteUrl: "https://api.densio.test/v1/artifacts/artifact-1",
} as const;
export const mediaCommand = {
  executable: "ffmpeg",
  arguments: ["-i", "source-video", "output.webm"],
  displayCommand: "ffmpeg -i source-video output.webm",
  startedAt: timestamp,
  completedAt: timestamp,
  exitCode: 0,
};
export const receipt = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  source: {
    filename: "homepage hero.mp4",
    declaredBytes: 50_000,
    verifiedBytes: 50_000,
    sha256: "c".repeat(64),
    durationSeconds: 10,
    encodedWidth: 1280,
    encodedHeight: 720,
    displayWidth: 1280,
    displayHeight: 720,
    rotationDegrees: 0,
    frameRate: { numerator: 30_000, denominator: 1_001 },
    streams: [{ index: 0, kind: "video", codec: "h264" }],
  },
  intent: {
    requestedOptions: { codecs: ["vp9"] },
    resolvedOptions: {
      codecs: ["vp9"],
      crf: { vp9: 42 },
      audio: "auto",
      frameRate: { mode: "preserve" },
    },
    executionPlanId: "plan-1",
    sourceId: "source-1",
    intentDigest: "b".repeat(64),
    clientReference: "homepage-hero/2026-08-14",
    idempotencyKey: "encode-homepage-hero",
  },
  execution: {
    attempts: 2,
    startedAt: timestamp,
    completedAt: timestamp,
    ffmpegVersion: "ffmpeg version 8.0",
    ffprobeVersion: "ffprobe version 8.0",
    commands: [mediaCommand],
  },
  billing: { actualCreditUnits: 25, actualCredits: 0.25 },
  artifacts: [artifactFacts],
} satisfies JobExecutionReceipt;
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
export const succeededJob = {
  ...jobBase,
  state: "succeeded",
  receipt,
  artifacts: [artifactDescriptor],
  progress: { phase: "complete", percent: 100, attempt: 2, revision: 8 },
  result: {
    kind: "compress",
    artifactIds: [artifactFacts.id],
    html: '<video src="./homepage-hero.webm"></video>',
  },
} satisfies JobStatus;
