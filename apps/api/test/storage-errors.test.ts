import { Effect, Result } from "effect";
import { expect, it } from "vitest";
import { storageEffect, storagePromise, storageFailure } from "../src/storage/storage-errors.ts";
import { classifyRouteFailure } from "../src/routes/route-failure.ts";

it("keeps unexpected async failures internal rather than calling them provider outages", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      storagePromise("storage-errors.test", async () => {
        throw new Error("database secret");
      }),
    ),
  );
  expect(Result.isFailure(result) && result.failure.code).toBe("STORAGE_INTERNAL_ERROR");
});

it("reports internal storage errors without disclosing the cause", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      storageEffect("storage-errors.test", () => {
        throw new Error("credential secret");
      }),
    ),
  );
  if (Result.isSuccess(result)) throw new Error("Expected failure");
  expect(result.failure.cause).toBeInstanceOf(Error);
  const classified = classifyRouteFailure(result.failure, "storage-correlation");
  expect(classified.report).toMatchObject({
    correlationId: "storage-correlation",
    errorTag: "VideoStorageError",
    operation: "storage-errors.test",
  });
  expect(classified.problem.status).toBe(500);
  expect(JSON.stringify(classified)).not.toContain("credential secret");
});

it("preserves explicit provider failures", async () => {
  const failure = storageFailure("STORAGE_PROVIDER_UNAVAILABLE");
  const result = await Effect.runPromise(
    Effect.result(
      storagePromise("storage-errors.test", async () => {
        throw failure;
      }),
    ),
  );
  expect(Result.isFailure(result) && result.failure).toBe(failure);
});
