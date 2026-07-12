import { and, eq } from "drizzle-orm";

import type { Database } from "./database.ts";
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

export const queueUploadedJob = (
  { db }: Database,
  input: {
    readonly bytes: number;
    readonly jobId: string;
    readonly now: number;
    readonly sha256: string;
    readonly userId: string;
  },
) =>
  db
    .update(jobs)
    .set({
      inputBytes: input.bytes,
      inputSha256: input.sha256,
      state: "queued",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.userId, input.userId),
        eq(jobs.state, "awaiting-upload"),
      ),
    )
    .returning()
    .get();

export const expireAwaitingUpload = (
  { db }: Database,
  input: { readonly jobId: string; readonly now: number; readonly userId: string },
) =>
  db
    .update(jobs)
    .set({ completedAt: input.now, progress: 100, state: "expired", updatedAt: input.now })
    .where(
      and(
        eq(jobs.id, input.jobId),
        eq(jobs.userId, input.userId),
        eq(jobs.state, "awaiting-upload"),
      ),
    )
    .returning()
    .get();
