import { and, asc, eq, lte } from "drizzle-orm";

import type { Database } from "./database.ts";
import { releaseJobCredits } from "./job-credit-ledger.ts";
import { jobs } from "./schema.ts";

export const findOwnedJob = (
  { db }: Database,
  input: { readonly jobId: string; readonly userId: string },
) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, input.jobId), eq(jobs.userId, input.userId)))
    .get();

export const claimUploadFinalization = (
  { db }: Database,
  input: {
    readonly bytes: number;
    readonly jobId: string;
    readonly now: number;
    readonly sha256: string;
    readonly stagingFile: string;
    readonly userId: string;
  },
) =>
  db
    .update(jobs)
    .set({
      inputBytes: input.bytes,
      inputSha256: input.sha256,
      updatedAt: input.now,
      uploadStagingFile: input.stagingFile,
      uploadState: "finalizing",
    })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.userId, input.userId),
        eq(jobs.state, "awaiting-upload"),
        eq(jobs.uploadState, "pending"),
      ),
    )
    .returning()
    .get();

export const listFinalizingUploads = ({ db }: Database, limit: number) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.state, "awaiting-upload"), eq(jobs.uploadState, "finalizing")))
    .orderBy(asc(jobs.createdAt))
    .limit(limit)
    .all();

export const queueFinalizedUpload = ({ db }: Database, jobId: string, now: number) =>
  db
    .update(jobs)
    .set({
      state: "queued",
      updatedAt: now,
      uploadStagingFile: null,
      uploadState: "pending",
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.state, "awaiting-upload"),
        eq(jobs.uploadState, "finalizing"),
      ),
    )
    .returning()
    .get();

export const resetFinalizingUpload = ({ db }: Database, jobId: string, now: number) =>
  db
    .update(jobs)
    .set({
      inputBytes: null,
      inputSha256: null,
      updatedAt: now,
      uploadStagingFile: null,
      uploadState: "pending",
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.state, "awaiting-upload"),
        eq(jobs.uploadState, "finalizing"),
      ),
    )
    .returning()
    .get();

export const requeueFrameRateDecision = (
  { db }: Database,
  input: {
    readonly jobId: string;
    readonly now: number;
    readonly optionsJson: string;
    readonly userId: string;
  },
) =>
  db
    .update(jobs)
    .set({
      optionsJson: input.optionsJson,
      state: "queued",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.userId, input.userId),
        eq(jobs.kind, "compress"),
        eq(jobs.state, "awaiting-decision"),
      ),
    )
    .returning()
    .get();

export const expireAwaitingUpload = (
  { db }: Database,
  input: { readonly jobId: string; readonly now: number; readonly userId: string },
) =>
  db.transaction(
    (transaction) => {
      const expired = transaction
        .update(jobs)
        .set({
          completedAt: input.now,
          progress: 100,
          state: "expired",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.userId, input.userId),
            eq(jobs.state, "awaiting-upload"),
            eq(jobs.uploadState, "pending"),
          ),
        )
        .returning()
        .get();
      if (expired !== undefined) releaseJobCredits(transaction, expired, input.now);
      return expired;
    },
    { behavior: "immediate" },
  );

export const expirePendingUploads = (
  { db }: Database,
  input: { readonly expiresAt: number; readonly limit: number; readonly now: number },
) =>
  db.transaction(
    (transaction) => {
      const candidates = transaction
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.state, "awaiting-upload"),
            eq(jobs.uploadState, "pending"),
            lte(jobs.createdAt, input.expiresAt),
          ),
        )
        .orderBy(asc(jobs.createdAt))
        .limit(input.limit)
        .all();
      return candidates.flatMap((job) => {
        const expired = transaction
          .update(jobs)
          .set({
            completedAt: input.now,
            progress: 100,
            state: "expired",
            updatedAt: input.now,
          })
          .where(
            and(
              eq(jobs.id, job.id),
              eq(jobs.state, "awaiting-upload"),
              eq(jobs.uploadState, "pending"),
            ),
          )
          .returning()
          .get();
        if (expired === undefined) return [];
        releaseJobCredits(transaction, expired, input.now);
        return [expired];
      });
    },
    { behavior: "immediate" },
  );
