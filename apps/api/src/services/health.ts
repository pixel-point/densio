import { Effect } from "effect";

export interface HealthStatus {
  readonly status: "ok";
}

export const getHealthStatus = Effect.fn("getHealthStatus")(
  function* (): Effect.fn.Return<HealthStatus> {
    return yield* Effect.succeed<HealthStatus>({
      status: "ok",
    });
  },
);
