import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

it("registers the E2E suite as a workspace package", async () => {
  const workspacePackage = await readJson(join(repositoryRoot, "package.json"));
  expect(readStringArray(workspacePackage, "workspaces")).toContain("e2e");
});

it("caches build artifacts needed by the E2E suite", async () => {
  const turbo = await readJson(join(repositoryRoot, "turbo.json"));
  expect(readBuildOutputs(turbo)).toContain("dist/**");
});

it("declares the E2E package's workspace dependencies", async () => {
  const e2ePackage = await readJson(join(repositoryRoot, "e2e/package.json"));
  expect(readRecord(e2ePackage, "dependencies")).toMatchObject({
    "@densio/api": "workspace:*",
    "@densio/shared": "workspace:*",
    densio: "workspace:*",
  });
});

it("runs the direct E2E command through the workspace dependency graph", async () => {
  const workspacePackage = await readJson(join(repositoryRoot, "package.json"));
  expect(readRecord(workspacePackage, "scripts")).toMatchObject({
    "test:e2e": "turbo run test --filter=@densio/e2e",
  });
});

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const readRecord = (value: unknown, key: string) => {
  if (typeof value !== "object" || value === null) return {};
  const candidate = Reflect.get(value, key);
  return typeof candidate === "object" && candidate !== null ? candidate : {};
};

const readStringArray = (value: unknown, key: string) => {
  const candidate = readRecord(value, key);
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string")
    : [];
};

const readBuildOutputs = (value: unknown) => {
  const tasks = readRecord(value, "tasks");
  const build = readRecord(tasks, "build");
  return readStringArray(build, "outputs");
};
