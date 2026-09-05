# Agent Instructions

## Monorepo Boundaries

- `apps/api` owns the HTTP API surface.
- `apps/cli` owns CLI entrypoints and command behavior.
- `packages/shared` owns public wire contracts, Effect schemas, plan metadata, and shared media policy. Production code must import these through `@densio/shared`; do not duplicate contracts or deep-import another workspace's source.
- Application packages must not import one another. Cross-application composition is limited to the `e2e` harness.
- Ensure new workspaces are covered by both `package.json` and `pnpm-workspace.yaml`; existing globs already cover directories under `apps/` and `packages/`. Use `workspace:*` for internal dependencies and update the lockfile. Change `turbo.json` only when task behavior differs from the existing defaults.

## Toolchain

- Treat Node.js 22.18 as the compatibility baseline and use pnpm 11.7.0 through Corepack.
- Use `pnpm install --frozen-lockfile`. Use pnpm for workspace dependency changes; npm is reserved for the tested CLI packaging and publishing workflow.

## Package Instructions

- Before changing files under `apps/api`, read `apps/api/AGENTS.md`.
- Before changing files under `apps/cli`, read `apps/cli/AGENTS.md`.

## Contract Changes

- For API contract changes, update the shared schema, Hono handler, OpenAPI metadata and response statuses, and contract tests together.
- When a contract is CLI-visible, also update the CLI decoder and follow the runtime skill synchronization rule below.
- The API remains authoritative for media inspection, codec policy, entitlements, billing, queueing, and cleanup. Do not duplicate server policy in the CLI.

## Runtime Skill Source

- `skill-bundle/` is the canonical runtime skill served by the API.
- `skills/densio/SKILL.md` is only the stable public bootstrap.
- When CLI-visible contracts, commands, flags, workflows, or errors change, update affected CLI help, the relevant `skill-bundle/references/*` files, and drift tests together.

## Secrets and Local Testing

- Never commit or expose `.env` contents, auth or refresh tokens, magic-link tokens, Stripe secrets or signatures, SQLite data, or signed artifact URLs outside intended command results.
- The CLI defaults to `https://api.densio.sh`. Local CLI testing must pass `--api-url` explicitly, and manual local CLI work must also use a disposable `--credentials` path.
- Use temporary SQLite databases, filesystems, local HTTP servers, and injected clocks for tests. Unit, integration, and local end-to-end tests must not contact deployed Densio, Stripe, Resend, live storage providers, or other external services.

## Testing

- Test observable behavior through the real implementation, including services and repositories where relevant. Assert outputs, persisted state, and errors rather than internal call sequences.
- Use controlled substitutes at external boundaries such as `EmailSender`, `StripeGateway`, and `ObjectStore`. Exercise provider adapters against local HTTP servers when testing their protocol behavior.
- Do not duplicate implementation logic into tests.

## Container Packaging

- Treat `.dockerignore` as an allowlist. When adding an API runtime asset or workspace dependency, update both `.dockerignore` and the Dockerfile copy and install inputs, then validate the image build.
- FFmpeg and FFprobe intentionally remain outside the application image. Preserve the read-only `/opt/ffmpeg` host mount unless the deployment architecture is explicitly changing.

## End-to-End Testing

- `pnpm test` includes the deterministic local golden journey and requires FFmpeg and FFprobe with `libsvtav1`, `libvpx-vp9`, and `libx265` encoders.
- Do not add production `E2E_MODE` branches or test-only HTTP routes. Inject local behavior at the provider boundaries described above.
- Do not run `pnpm synthetic:staging` or `pnpm synthetic:production` as routine validation. Run them only when explicitly requested with a reachable deployment and dedicated credentials.

## Completion Checks

- Inspect the working-tree changes before editing. Preserve existing work, keep edits scoped to the task, and avoid formatting unrelated files.
- Package-filtered tests and typechecks are appropriate during iteration.
- Read-only reviews do not require formatting or completion checks; run read-only checks only when needed to support the review or explicitly requested.
- For documentation-only changes outside embedded runtime assets, format the changed files with `pnpm exec oxfmt --disable-nested-config --write <files>` and verify them with `pnpm exec oxfmt --disable-nested-config --check <files>`. Tests, typechecks, and builds are not required for prose-only changes.
- For code or configuration changes, run `pnpm format` followed by `pnpm check` from the repository root. If root formatting would change unrelated files, format only the task's files with the scoped command above, then run `pnpm check`. The check command includes typechecks, tests, lint, and formatting verification.
- Also run `pnpm build` after changing entrypoints, package manifests, bundling, Docker inputs, release tooling, or embedded runtime assets.
- Report checks run, failures, and checks that could not run with their missing prerequisites. Identify pre-existing failures only when supported by evidence, and report unrelated failures separately without expanding the task to fix them.

## Lint Rules

- Do not weaken or disable lint rules to bypass failures unless the change is clearly justified by the task.
- Do not bypass the 100-line function limit or 1000-line file limit. Split code into clearer modules or functions instead.

## Style Guide

### General Principles

- Keep cohesive logic together. Extract helpers when they name a domain concept, isolate a complex boundary, enable reuse, or keep functions within lint limits.
- Make the main function read as the happy path. Keep supporting helpers close to the code they serve, below the main export when that improves readability; leave simple expressions inline when extraction adds no clarity.
- Avoid `try`/`catch` where possible.
- Avoid `any`.
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity.
- Prefer functional array methods like `map`, `filter`, and `flatMap` over loops when they make the data flow clearer.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Imports

- Never alias imports.
- Never use star imports.

### Variables

- Prefer `const` over `let`.
- Use ternaries or early returns instead of reassignment.
- Use named intermediate values when they clarify intent, even when used only once. Inline values when doing so keeps the expression easy to read.

### Control Flow

- Avoid `else` statements.
- Prefer early returns.
