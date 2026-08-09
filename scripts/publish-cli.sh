#!/bin/sh

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd)
cd "$repository_root"

usage() {
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
}

fail() {
  echo "Error: $1" >&2
  exit 1
}

dry_run=false
case "$#" in
  0) ;;
  1)
    [ "$1" = "--dry-run" ] || usage
    dry_run=true
    ;;
  *) usage ;;
esac

[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] ||
  fail "run this script from a Git checkout"
[ -z "$(git status --porcelain)" ] || fail "the Git worktree must be clean"

package_name=$(node -p "require('./apps/cli/package.json').name")
version=$(node -p "require('./apps/cli/package.json').version")
[ "$package_name" = "densio" ] || fail "apps/cli must be the densio package"
node -e '
  const version = process.argv[1];
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) process.exit(1);
' "$version" || fail "apps/cli must have a stable semantic version"

pnpm lint
pnpm format:check
pnpm test
pnpm typecheck
pnpm build

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/densio-publish.XXXXXX")
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

pack_directory="$temporary_root/pack"
install_directory="$temporary_root/install"
mkdir -p "$pack_directory" "$install_directory"

npm pack --pack-destination "$pack_directory" ./apps/cli >/dev/null
archive="$pack_directory/densio-$version.tgz"
[ -f "$archive" ] || fail "npm pack did not create the expected archive"

tar -tzf "$archive" | LC_ALL=C sort >"$temporary_root/actual-files"
printf '%s\n' \
  package/LICENSE \
  package/README.md \
  package/dist/index.js \
  package/package.json >"$temporary_root/expected-files"
if ! diff -u "$temporary_root/expected-files" "$temporary_root/actual-files"; then
  fail "the npm archive contains unexpected files"
fi

npm install \
  --prefix "$install_directory" \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --package-lock=false \
  "$archive" >/dev/null

help_output=$("$install_directory/node_modules/.bin/densio" --help)
case "$help_output" in
  *"densio — agent-first video processing"*) ;;
  *) fail "the packed densio executable did not return its help text" ;;
esac

if [ "$dry_run" = "true" ]; then
  echo "Dry run passed for densio v$version. No registry changes were made."
  exit 0
fi

npm whoami >/dev/null || fail "npm authentication is required"
registry_error="$temporary_root/npm-view-error"
if npm view "densio@$version" version --json >"$temporary_root/npm-view-output" 2>"$registry_error"; then
  fail "densio v$version is already published"
fi
if ! grep -q "E404" "$registry_error"; then
  cat "$registry_error" >&2
  fail "could not determine whether densio v$version is unpublished"
fi

npm publish "$archive" --access public
echo "Published densio v$version. Push the release commit manually with: git push"
