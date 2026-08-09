import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";

import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { checkReadiness, ReadinessError } from "../src/services/readiness.ts";
import { createHealthRoutes } from "../src/routes/health.ts";

const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("checks SQLite and writable media storage without exposing paths", async () => {
  const { database, root } = await createTestDatabase();

  await expect(
    Effect.runPromise(
      checkReadiness(database, join(root, "media"), {
        ffmpegVersion: "7.1-static",
        ffprobeVersion: "7.1-static",
      }),
    ),
  ).resolves.toEqual({
    ffmpegVersion: "7.1-static",
    ffprobeVersion: "7.1-static",
    status: "ready",
  });
});

it("fails closed when the media root is not writable as a directory", async () => {
  const { database, root } = await createTestDatabase();
  const invalidRoot = join(root, "not-a-directory");
  await writeFile(invalidRoot, "file");

  const error = await Effect.runPromise(
    Effect.flip(
      checkReadiness(database, invalidRoot, {
        ffmpegVersion: "7.1-static",
        ffprobeVersion: "7.1-static",
      }),
    ),
  );

  expect(error).toBeInstanceOf(ReadinessError);
});

it("serves readiness without exposing internal failure details", async () => {
  const app = new Hono();
  app.route(
    "/",
    createHealthRoutes(() =>
      Effect.fail(new ReadinessError({ cause: new Error("private path"), check: "storage" })),
    ),
  );

  const response = await app.request("/ready");

  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({ status: "not-ready" });
});

const createTestDatabase = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-readiness-"));
  temporaryDirectories.push(root);
  const database = openDatabase(join(root, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return { database, root };
};
