import type { JobWorkflow } from "@densio/shared";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { listOwnedJobEvents } from "../database/job-event-repository.ts";
import { listOwnedJobs, lookupOwnedJob } from "../database/job-query-repository.ts";
import { findOwnedJob } from "../database/job-repository.ts";
import { cancelOrganizationJob } from "../database/job-transition-repository.ts";
import type { jobs } from "../database/schema.ts";
import { cleanupTerminalJob } from "./terminal-workspace-cleanup.ts";
import { tryJobRepository } from "./job-effect-support.ts";
import { JobNotFound } from "./job-errors.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import {
  projectJobStatus,
  projectJobSummary,
  type JobProjectionConfig,
} from "./job-status-projector.ts";

export interface JobServiceConfig extends JobProjectionConfig {
  readonly mediaRoot: string;
}
interface OwnedJobInput extends OrganizationActor {
  readonly correlationId: string;
  readonly jobId: string;
  readonly organizationId: string;
}
interface ListJobsInput extends OrganizationActor {
  readonly clientReference?: string;
  readonly correlationId: string;
  readonly cursor?: string;
  readonly idempotencyKey?: string;
  readonly limit: number;
  readonly since?: number;
  readonly state?: typeof jobs.$inferSelect.state;
  readonly organizationId: string;
  readonly workflow?: JobWorkflow;
}
type LookupJobInput = Parameters<typeof lookupOwnedJob>[1] &
  OrganizationActor & { readonly correlationId: string };

export const makeJobService = (database: Database, config: JobServiceConfig) => ({
  status: Effect.fn("JobService.status")(function* (input: OwnedJobInput) {
    const job = yield* ownedJob(database, input);
    return yield* projectJobStatus(database, job, input.correlationId, config);
  }),
  cancel: Effect.fn("JobService.cancel")(function* (
    input: OwnedJobInput & { readonly now: number },
  ) {
    const existing = yield* ownedJob(database, input);
    const job =
      (yield* tryJobRepository("cancel", () =>
        cancelOrganizationJob(database, {
          jobId: input.jobId,
          actor: input,
          now: input.now,
        }),
      )) ?? existing;
    if (job.state === "canceled") {
      yield* cleanupTerminalJob(database, config.mediaRoot, job.id);
    }
    return yield* projectJobStatus(database, job, input.correlationId, config);
  }),
  list: Effect.fn("JobService.list")(function* (input: ListJobsInput) {
    yield* organizationStorage("authorize-job-list", () =>
      authorizeOrganization(database.db, input, "media-read"),
    );
    const page = yield* listOwnedJobs(database, input);
    return {
      organizationId: input.organizationId,
      jobs: yield* Effect.forEach(page.jobs, (job) => projectJobSummary(database, job, config)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }),
  lookup: Effect.fn("JobService.lookup")(function* (input: LookupJobInput) {
    yield* organizationStorage("authorize-job-lookup", () =>
      authorizeOrganization(database.db, input, "media-read"),
    );
    const job = yield* lookupOwnedJob(database, input);
    if (job === undefined) return yield* new JobNotFound();
    return yield* projectJobStatus(database, job, input.correlationId, config);
  }),
  events: Effect.fn("JobService.events")(function* (
    input: Parameters<typeof listOwnedJobEvents>[1] & OrganizationActor,
  ) {
    yield* organizationStorage("authorize-job-events", () =>
      authorizeOrganization(database.db, input, "media-read"),
    );
    const page = yield* listOwnedJobEvents(database, input);
    if (page === undefined) return yield* new JobNotFound();
    return page;
  }),
});

const ownedJob = Effect.fn("JobService.owned")(function* (
  database: Database,
  input: OwnedJobInput,
) {
  yield* organizationStorage("authorize-job", () =>
    authorizeOrganization(database.db, input, "media-read"),
  );
  const job = yield* tryJobRepository("find-owned", () => findOwnedJob(database, input));
  if (job === undefined) return yield* new JobNotFound();
  return job;
});
