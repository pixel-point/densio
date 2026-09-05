import type { ArtifactKind, MediaCodec } from "@densio/shared";

export interface StagedWorkflowOutput {
  readonly artifactFilename: string;
  readonly codec?: MediaCodec;
  readonly durationSeconds?: number;
  readonly height?: number;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly stagedFilename: string;
  readonly width?: number;
}

export interface WorkflowCommandDiagnostic {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly displayCommand: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly exitCode: number;
  readonly stderrTail?: string;
}
