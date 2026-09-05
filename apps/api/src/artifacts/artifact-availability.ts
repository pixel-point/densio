import type { ArtifactAvailability } from "@densio/shared";

export const artifactAvailability = (
  artifact: { readonly retainedUntil: number; readonly deletedAt: number | null },
  now: number,
): ArtifactAvailability =>
  now >= artifact.retainedUntil ? "expired" : artifact.deletedAt !== null ? "deleted" : "available";
