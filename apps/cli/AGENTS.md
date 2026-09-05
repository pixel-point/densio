# CLI Agent Instructions

## Machine Interface

- For `--json` command results, stdout is exactly one schema-versioned success document.
- Progress, status events, and problems go to stderr as one JSON object per line.
- Preserve documented exit-code meanings and existing help behavior.

## Credentials

- Preserve owner-only, atomic credential writes and normalized API-origin binding.
- Tests must use disposable credential files and must not read or overwrite the developer's real credentials.

## Packaging and Releases

- Preserve the standalone bundled `dist/index.js` package without runtime dependency entries.
- Do not commit generated `dist` output.
- Use `scripts/bump-cli-version.sh` and `scripts/publish-cli.sh`; do not manually reproduce their release steps.
- Run publishing with `--dry-run` first. Commit, publish, tag, or push only when explicitly requested.
