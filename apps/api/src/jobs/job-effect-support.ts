import { Effect } from "effect";

import { JobRepositoryError } from "./job-errors.ts";

export const tryJobRepository = Effect.fn("JobRepository.evaluate")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new JobRepositoryError({ cause, operation }),
      try: evaluate,
    }),
);
