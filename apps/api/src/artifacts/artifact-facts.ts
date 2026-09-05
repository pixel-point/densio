import { ArtifactReceiptSchema } from "@densio/shared";
import { Schema } from "effect";
import type { artifacts } from "../database/schema.ts";

export const artifactFacts = (artifact: typeof artifacts.$inferSelect) =>
  Schema.decodeUnknownSync(ArtifactReceiptSchema)({
    organizationId: artifact.organizationId,
    id: artifact.id,
    bytes: artifact.sizeBytes,
    filename: artifact.filename,
    kind: artifact.kind,
    mediaType: artifact.mediaType,
    sha256: artifact.sha256,
    retainedUntil: new Date(artifact.retainedUntil).toISOString(),
    ...(artifact.codec === null ? {} : { codec: artifact.codec }),
    ...(artifact.width === null ? {} : { width: artifact.width }),
    ...(artifact.height === null ? {} : { height: artifact.height }),
    ...(artifact.durationSeconds === null ? {} : { durationSeconds: artifact.durationSeconds }),
  });
