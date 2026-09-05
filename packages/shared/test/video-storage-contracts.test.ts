import { Schema } from "effect";
import { expect, test } from "vitest";
import { ExecutionPlanCreateRequestSchema, PLAN_CATALOG } from "../src/index.ts";

test("storage capacity follows the organization's plan independently of compression credits", () => {
  expect(PLAN_CATALOG.free).toMatchObject({ includedStorageBytes: 0, customerStorage: true });
  expect(PLAN_CATALOG.basic).toMatchObject({ includedStorageBytes: 25_000_000_000 });
  expect(PLAN_CATALOG.pro).toMatchObject({ includedStorageBytes: 100_000_000_000 });
  expect(PLAN_CATALOG.scale).toMatchObject({ includedStorageBytes: 500_000_000_000 });
});

test("compression plans preserve an explicit destination, visibility, and video name", () => {
  const storage = {
    destination: { kind: "managed" },
    visibility: "private",
    name: "Homepage Hero",
  };
  expect(
    Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema)({
      sourceId: "source-one",
      workflow: "compress",
      storage,
    }),
  ).toMatchObject({ storage });
});

test("customer storage is a distinct destination in the public request contract", () => {
  const storage = { destination: { kind: "connection", connectionId: "connection-one" } };
  expect(
    Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema)({
      sourceId: "source-one",
      workflow: "compress",
      storage,
    }),
  ).toMatchObject({ storage });
});
