# API Agent Instructions

## Effect v4

- An optional Effect reference checkout belongs at `repos/effect/` relative to the repository root (`../../repos/effect/` from `apps/api/`). When present, read its `LLMS.md` before changing Effect-based application code.
- Check examples against the Effect version installed for `apps/api`. Prefer compatible local reference material; if the checkout or `LLMS.md` is absent or incompatible, use the installed dependencies' source and types under `apps/api/node_modules/`. A missing optional checkout does not block API work.
- Treat the repository-root `repos/` directory as read-only unless explicitly asked to edit it. Application code must import from package dependencies, never from reference checkouts.

## API Boundaries

- Hono owns HTTP transport and routing.
- Effect owns business logic, services, schemas, errors, and workflows.

## Domain Invariants

- Scope organization-owned resource reads and writes to the authorized organization and enforce the operation's membership and role requirements. Creator identity is audit metadata, not resource ownership; already-admitted work must survive creator removal.
- Preserve immutable execution-plan snapshots and their exact intent digests and credit quotes. Job admission must validate the referenced source and plan and enforce current authorization, entitlements, and credit guards.
- Preserve idempotent replay and conflict behavior. Retries and recovery must reuse durable operation evidence without duplicating jobs, billing effects, or credit accounting.
- Preserve worker lease ownership, recoverable storage transfers, artifact access revocation, and cleanup ordering. Artifact or source cleanup must not rewrite a successful job's receipt.
- When changing these behaviors, cover the relevant cross-organization denial, replay/conflict, interruption/recovery, or cleanup cases through real services and persistence. See repository-root `e2e/README.md` for the existing golden journey.

## HTTP Contracts

- Every registered API operation must have matching OpenAPI metadata, exact documented response statuses, shared request and response schemas where applicable, and contract tests.

## Database Migrations

- Any persisted schema change in definitions loaded by `apps/api/drizzle.config.ts`, including modules imported or re-exported by `src/database/schema.ts`, requires a new forward migration under `apps/api/drizzle/`. Pure refactoring that preserves the database schema does not require a migration.
- Generate schema migrations from the repository root with `pnpm --filter @densio/api db:generate` and include the generated migration and snapshots with the schema change.
- Never rewrite applied migrations or hand-edit generated historical snapshots. Add a focused migration test when existing data must be transformed.

## Media Process Execution

- Build FFmpeg and FFprobe invocations as an executable plus an argument array and execute them with `shell: false`.
- Display-form commands are diagnostics only and must never become executable input.

## Effect Style

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named Effect-returning functions.
- Do not return `Effect` from helpers unless they actually perform effectful work.
- In `Effect.gen` / `Effect.fn`, bind services to named variables before calling methods.
- Avoid nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Use `Effect.void` instead of `Effect.succeed(undefined)`.
- Prefer Effect Schema helpers for parsing untrusted input over manual `JSON.parse` wrappers.
