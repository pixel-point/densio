# Pulse monitoring checks

## Ownership and execution

- Keep public website and agent-service monitors here as `*.spec.ts`. The root
  `siteos.config.json` selects checks and schedules; `siteos.playwright.config.ts` owns Chromium
  configuration. Update their paths together when moving a spec.
- Preserve the existing `e2e` Vitest `**/*.test.ts` discovery. Production Pulse requests must not
  run through `pnpm test` or `pnpm check`. The existing `e2e` typecheck includes these specs and
  the root Playwright configuration.
- Keep browser DOM types in this directory's `tsconfig.json`, separate from the parent Node-only
  harness. The `e2e` package's `typecheck` command must run both configurations; combining their
  global types causes incompatible Node and browser stream definitions in the API harness.
- Keep coverage descriptions and operator commands in `../README.md#siteos-pulse-monitoring`;
  keep durable agent rules here. Do not duplicate the SiteOS plugin's general workflow.

## Production boundaries

- Use fresh anonymous browser contexts and relative website paths. The selected SiteOS environment
  supplies `PLAYWRIGHT_BASE_URL`. Keep a single worker, no retries, bounded timeouts, and failure
  artifacts under the Git-ignored `.siteos/pulse/` directory.
- `agent-service.spec.ts` deliberately targets the public CLI's production default,
  `https://api.densio.sh`. A website base-URL override does not retarget it. Exclude that spec when
  checking only a local website; do not infer another API origin from a website hostname.
- Do not send login emails, create or change accounts, upload media, start processing jobs, or
  perform purchases. Preserve the invalid-email check's write-request blocking and its assertion
  that no write was attempted. New stateful scenarios need an explicitly authorized isolated
  test-data contract; see the deployed synthetics in the parent README.
- Keep Project IDs and credentials in private CLI state. Never put tokens, auth state, signed
  artifact URLs, or private data in the bundle or tracked reports.

## Verification and publication

- For changes to these checks, run the existing `pnpm typecheck:e2e`, then the Pulse validation,
  sync preview, test, and deployment dry-run commands documented in the parent README. Apply the
  repository's completion checks as well. Inspect the manifest for only intended runtime files.
- Preserve meaningful user-observable assertions. API readiness does not prove a completed
  compression job; legal-page rendering does not establish the quality of legal content.
- Publication requires the user's explicit approval. After an approved deployment, inspect
  terminal remote results for each deployed check. Report local tests, bundle construction,
  deployment, manual runs, and subsequent scheduled results separately.
