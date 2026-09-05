import { ExecutionPlanSnapshotSchema } from "@densio/shared";
import { eq } from "drizzle-orm";
import { Schema } from "effect";
import type { DatabaseTransaction } from "../database/database.ts";
import { artifacts, executionPlans, type jobs } from "../database/schema.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import { recordVideoIntent } from "./video-intent.ts";

export const recordAutomaticVideo = (
  transaction: DatabaseTransaction,
  job: typeof jobs.$inferSelect,
  now: number,
) => {
  if (
    (job.kind !== "compress" && job.kind !== "trim" && job.kind !== "hls") ||
    job.state !== "succeeded"
  )
    return;
  const plan = transaction
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.id, job.executionPlanId))
    .get();
  if (!plan) throw new Error("The execution plan is missing.");
  const snapshot = Schema.decodeUnknownSync(Schema.fromJsonString(ExecutionPlanSnapshotSchema))(
    plan.snapshotJson,
  );
  if (
    (snapshot.workflow !== "compress" &&
      snapshot.workflow !== "trim" &&
      snapshot.workflow !== "hls") ||
    !snapshot.storage ||
    !("visibility" in snapshot.storage)
  )
    return;
  recordVideoIntent(transaction, {
    organizationId: job.organizationId,
    jobId: job.id,
    storage: snapshot.storage,
    artifacts: transaction.select().from(artifacts).where(eq(artifacts.jobId, job.id)).all(),
    automatic: true,
    now,
    idempotencyKey: `automatic:${job.id}`,
    requestDigest: canonicalDigest({ jobId: job.id, storage: snapshot.storage }),
  });
};
