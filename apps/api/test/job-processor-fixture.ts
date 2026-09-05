import { Effect, Schema } from "effect";
import { JobProcessor, type Job, type JobProcessorError } from "../src/jobs/job-worker.ts";

export const makeJobProcessor = (fixture: {
  readonly analyze: (
    job: Job,
  ) => Effect.Effect<
    { readonly creditUnits: number; readonly data: Schema.Json; readonly kind: "ready" },
    JobProcessorError
  >;
  readonly process: (job: Job, data: Schema.Json) => Effect.Effect<Schema.Json, JobProcessorError>;
}) =>
  JobProcessor.of({
    analyze: (job) =>
      fixture.analyze(job).pipe(
        Effect.map((analysis) => ({
          kind: "ready",
          creditUnits: analysis.creditUnits,
          process: (currentJob: Job) => fixture.process(currentJob, analysis.data),
        })),
      ),
  });
