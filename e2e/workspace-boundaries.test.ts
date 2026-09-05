import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspaces = ["apps/api", "apps/cli", "packages/shared"];
const ownerOf = (path: string) => workspaces.find((workspace) => path.startsWith(`${workspace}/`));
const forbiddenImport = (file: string, specifier: string) => {
  if (specifier.startsWith("@densio/shared/")) return true;
  if (
    ["@densio/api", "densio"].some((name) => specifier === name || specifier.startsWith(`${name}/`))
  )
    return true;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return false;
  const source = ownerOf(file);
  const target = ownerOf(relative(root, resolve(root, dirname(file), specifier)));
  return target !== undefined && target !== source;
};
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });

test("production workspace imports respect application ownership and the shared public entrypoint", () => {
  const violations = workspaces
    .flatMap((workspace) => sourceFiles(join(root, workspace, "src")))
    .flatMap((path) => {
      const file = relative(root, path);
      return [
        ...readFileSync(path, "utf8").matchAll(
          /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g,
        ),
      ].flatMap((match) => (forbiddenImport(file, match[1]!) ? [`${file}: ${match[1]}`] : []));
    });
  expect(violations).toEqual([]);
});

test.each([
  ["apps/api/src/server.ts", "../../cli/src/cli.ts", true],
  ["apps/cli/src/cli.ts", "@densio/api", true],
  ["apps/cli/src/cli.ts", "../../../packages/shared/src/index.ts", true],
  ["apps/api/src/server.ts", "@densio/shared/internal", true],
  ["packages/shared/src/index.ts", "../../../apps/api/src/server.ts", true],
  ["apps/api/src/server.ts", "./app.ts", false],
  ["apps/cli/src/cli.ts", "@densio/shared", false],
])("import ownership: %s → %s", (file, specifier, forbidden) => {
  expect(forbiddenImport(file, specifier)).toBe(forbidden);
});
