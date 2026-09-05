#!/bin/sh

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)
cd "$repository_root"

usage() {
  echo "Usage: $0 <patch|minor|major|X.Y.Z>" >&2
  exit 2
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
release=$1

case "$release" in
  patch | minor | major) ;;
  *)
    node -e '
      const version = process.argv[1];
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) process.exit(1);
    ' "$release" || usage
    ;;
esac

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] ||
  fail "run this script from a Git checkout"
[ -z "$(git status --porcelain)" ] || fail "the Git worktree must be clean"

previous_version=$(node -p "require('./apps/cli/package.json').version")
(cd apps/cli && pnpm version "$release" --no-git-tag-version) >/dev/null
version=$(node -p "require('./apps/cli/package.json').version")

node -e '
  const version = process.argv[1];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) process.exit(1);
' "$version" || fail "the resulting package version is not stable semantic versioning"

[ "$version" != "$previous_version" ] || fail "the requested version is already current"
[ "$(git diff --name-only)" = "apps/cli/package.json" ] ||
  fail "the version command changed files outside apps/cli/package.json"

git add -- apps/cli/package.json
git commit -m "chore(cli): release v$version" -- apps/cli/package.json

echo "Created release commit for densio v$version."
echo "Push it manually with: git push"
