import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("includes external workspace inputs in the real task cache graph", () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const graph = JSON.parse(
    execFileSync(
      join(root, "node_modules/.bin/turbo"),
      ["run", "build", "test", "test:fast", "test:media", "--dry=json"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
      },
    ),
  ) as {
    globalCacheInputs: { files: Record<string, string> };
    tasks: Array<{
      taskId: string;
      inputs: Record<string, string>;
      dependencies: string[];
      outputs: string[] | null;
    }>;
  };
  expect(Object.keys(graph.globalCacheInputs.files)).toContain("tsconfig.base.json");
  const includes = (taskId: string, file: string) =>
    expect(Object.keys(graph.tasks.find((task) => task.taskId === taskId)?.inputs ?? {})).toEqual(
      expect.arrayContaining([expect.stringContaining(file)]),
    );
  expect(graph.tasks.find((task) => task.taskId === "@densio/api#build")?.outputs).toContain(
    "dist/**",
  );
  for (const taskId of [
    "@densio/api#build",
    "@densio/api#test",
    "@densio/api#test:fast",
    "densio#test",
    "densio#test:fast",
  ]) {
    expect(graph.tasks.find((task) => task.taskId === taskId)?.dependencies, taskId).toContain(
      "@densio/shared#build",
    );
  }
  for (const name of ["test", "test:fast", "test:media"]) {
    expect(graph.tasks.find((task) => task.taskId === `@densio/e2e#${name}`)?.dependencies).toEqual(
      expect.arrayContaining(["@densio/api#build", "densio#build"]),
    );
  }
  includes("@densio/api#build", "src/server.ts");
  includes("@densio/api#build", "skill-bundle/entrypoint.md");
  includes("@densio/api#test", "skill-bundle/entrypoint.md");
  includes("densio#test", "skill-bundle/references/commands.md");
  includes("densio#test", "scripts/publish-cli.sh");
  includes("densio#test", "skills/densio/SKILL.md");
});
