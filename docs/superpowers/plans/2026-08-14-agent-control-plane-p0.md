# Agent control-plane P0 implementation plan

> Design authority: `docs/superpowers/specs/2026-08-14-agent-control-plane-p0-design.md`
>
> Delivery rule: every behavior change starts with a focused failing test, the failure is observed,
> then the smallest implementation makes it pass. Each gate is green before a dependent gate starts.

## Worktree safety

The repository already contains unrelated user-owned application-lifecycle and E2E changes. Preserve
them. In particular, integrate with but do not revert:

- `apps/api/src/server.ts`
- `apps/api/src/application.ts`
- `apps/api/src/http/application-server.ts`
- `apps/api/test/application-server.test.ts`
- root workspace manifests and `e2e/`

Use `apply_patch` for edits. Stage only explicitly named P0 files if a commit is requested. Never run
deployed synthetic checks as routine validation.

## Gate 1: shared contracts

### 1.1 Prepared-source contracts

Files:

- Add `packages/shared/src/source-contracts.ts`
- Update `packages/shared/src/index.ts`
- Add `packages/shared/test/source-contracts.test.ts`

Red tests:

- create request accepts safe filename/positive bytes and rejects paths/zero;
- every source-state variant decodes with required state-specific fields;
- ready inspection accepts rational FPS, dimensions, rotation, and stream facts;
- idempotent create response exposes `replayed` and only uploadable state has upload action;
- deletion receipt and source action schemas reject malformed URLs/timestamps.

Green implementation:

- source create/status/inspection/action/deletion schemas and inferred types;
- reuse common URL/time/identifier/number schemas;
- no duplicated media option or problem contracts.

Verify:

```text
pnpm --filter @densio/shared test -- source-contracts.test.ts
pnpm --filter @densio/shared typecheck
```

### 1.2 Execution-plan contracts

Files:

- Add `packages/shared/src/execution-plan-contracts.ts`
- Update `packages/shared/src/index.ts`
- Add `packages/shared/test/execution-plan-contracts.test.ts`

Red tests:

- discriminated create requests pair each workflow with its option schema;
- ready and decision-required immutable plan variants decode;
- exact quote, policy/profile versions, intent digest, expected artifacts, and warnings are required;
- credit guards reject more than two decimal places and output guard rejects zero/fractions;
- execute request requires no idempotency body field and supports reference/guards;
- replayed resolve/execute responses decode and expired plans cannot expose execute action.

Green implementation:

- typed request/status/quote/constraint/artifact/action/resolve/execute schemas;
- `CreditAmountSchema` maps only positive two-decimal credit values;
- request options remain workflow-typed while requested/resolved snapshots use the same schemas.

### 1.3 Recovery, progress, provenance, and artifacts

Files:

- Update `packages/shared/src/job-contracts.ts`
- Update `packages/shared/src/artifact-contracts.ts`
- Update `packages/shared/src/media-results.ts`
- Update `packages/shared/src/index.ts`
- Update/add matching shared tests

Red tests:

- client references reject control characters and values over 200;
- create requests accept root client reference;
- replayed job creation can omit upload and report current state;
- progress accepts concurrent active outputs and distinguishes revision from event sequence;
- unsuccessful terminal statuses preserve partial percent and correct terminal phase;
- action sets, job summary/list/lookup, and event page decode;
- receipt requires source, intent, execution, billing, and artifact facts;
- stable artifact descriptor, independent authorization, deletion, and materialization receipts decode;
- legacy artifact metadata remains decodable with an initial ephemeral URL.

### 1.4 Matrix comparison contracts

Files:

- Update `packages/shared/src/media-options.ts`
- Update `packages/shared/src/media-results.ts`
- Update `packages/shared/src/index.ts`
- Update `packages/shared/test/media-contracts.test.ts`

Red tests:

- legacy comparison remains accepted;
- matrix accepts 2-8 unique codec/CRF candidates;
- duplicate pairs, ninth candidate, invalid codec CRF, and mixed legacy/matrix fields reject;
- scenes accept auto 2-5 or unique explicit 2-5 positions;
- metrics require SSIM and optionally PSNR;
- result accepts scene facts, per-candidate metrics, Pareto flags, explicit infinite PSNR, and decision;
- deprecated legacy result fields are optional compatibility fields.

Gate acceptance: all shared tests/typecheck green before API or CLI consumes the new contracts.

## Gate 2: database schema and forward migration

Files:

- Update `apps/api/src/database/schema.ts`
- Generate one new `apps/api/drizzle/<generated>/migration.sql` and snapshot
- Update database/migration tests

Red tests:

- migrated temporary DB exposes all new tables/columns/indexes;
- existing-style rows remain readable after migration;
- legacy artifact token becomes an access-grant row with original expiry;
- account client reference uniqueness and access-grant/job-event foreign keys hold.

Schema:

- `prepared_sources` with upload/inspection/recovery/expiry fields;
- `execution_plans` with immutable snapshots, digest, decision, quote, replay, and expiry fields;
- job source/plan/client-reference/intent/guard/provenance/progress fields and indexes;
- append-only `job_events` with integer sequence;
- artifact retention/media metadata fields;
- independent `artifact_access_grants`.

Generate exactly through:

```text
pnpm --filter @densio/api db:generate
```

Inspect generated SQL; do not hand-author or edit a generated migration.

## Gate 3: prepared sources

### 3.1 Branded storage boundary

Files:

- Add `apps/api/src/storage/source-workspace.ts`
- Add `apps/api/test/source-workspace.test.ts`

Red tests cover safe IDs, containment, prepare/cleanup, staging resolution, and rejection of traversal.

### 3.2 Repository and service

Files:

- Add `apps/api/src/database/prepared-source-repository.ts`
- Add `apps/api/src/sources/prepared-source-service.ts`
- Add focused repository/service tests

Red tests cover owner isolation, source-create idempotency, conflict comparison, size/plan limits,
streamed hash/size verification, finalizing recovery, trusted inspection persistence, safe failures,
expiry, deletion, and cleanup.

Implementation reuses storage-upload primitives and `MediaInspector`. State/event mutations are
immediate transactions. Inspection is FFprobe-only and runs with the existing bounded process runner.

### 3.3 Routes and lifecycle

Files:

- Add `apps/api/src/routes/sources.ts`
- Add `apps/api/src/routes/problems/source-problems.ts`
- Update `apps/api/src/app.ts`, `apps/api/src/application.ts`, `apps/api/src/config.ts`
- Add route/OpenAPI/config/application tests

Routes: create, upload, get, delete. Authenticate every operation, validate idempotency, return exact
201/200 statuses, and expose all documented problems. Extend maintenance and configuration with source
TTL. Gate acceptance includes service, route, OpenAPI, config, and application tests.

## Gate 4: immutable planning and guarded execution

### 4.1 Pure resolution and digest

Files:

- Add `apps/api/src/execution-plans/execution-plan-resolution.ts`
- Add `apps/api/src/execution-plans/canonical-json.ts`
- Add pure tests

Red tests cover canonical key ordering, workflow defaults, CRFs/codecs, audio/frame-rate decisions,
dimensions, output manifest, extraction image limit, comparison scene resolution, entitlement,
aggregate comparison quote, and digest stability/sensitivity.

### 4.2 Repository/service/routes

Files:

- Add plan repository/service/routes/problem modules and tests
- Update application dependencies and OpenAPI matrix

Red tests cover immutable create/resolve child, replay/conflict, ownership, expiry, policy retirement,
tool drift recording, available-credit snapshot, exact guards, and mandatory execute idempotency.

### 4.3 Prepared-source job attachment

Files:

- Extend job service/upload lifecycle/repositories/worker and focused tests

Red tests cover exact initial reservation, hard-link success, EXDEV/unsupported copy fallback,
byte/hash verification, finalizing recovery, public-upload rejection, source deletion race, replayed
execution, plan-unit divergence before encode, and post-encode output-byte failure with full usage.

Gate acceptance: source can be uploaded once, planned, resolved, executed twice with distinct keys,
and every resulting job owns a verified input independent from source expiry.

## Gate 5: job discovery, events, and provenance

### 5.1 Repositories

Files:

- Extend job repository/lifecycle repository or add narrow history/event modules
- Add repository tests

Red tests cover every list filter, owner isolation, equal-timestamp keyset pagination, invalid cursor,
idempotency/reference lookup, account-unique client references, event ordering/page cursor, and an
event in the same transaction as every visible transition.

### 5.2 Status service/routes

Files:

- Refactor `apps/api/src/jobs/job-service.ts` below the public operations
- Extend `apps/api/src/routes/media-jobs.ts`
- Update problem mappings and route/OpenAPI tests

Red tests cover legal actions per state, replay status, rich safe terminal problems, progress fallback
for old rows, requested/resolved options, receipt source/tool/attempt/credit/artifact facts, list/lookup,
and finite event pages.

No public route reconstructs an artifact from stale `resultJson`; succeeded status joins stable
artifact rows and derives current availability/action URLs.

## Gate 6: artifact lifecycle

Files:

- Extend `apps/api/src/database/artifact-repository.ts`
- Extend `apps/api/src/jobs/artifact-publication.ts`
- Extend `apps/api/src/routes/artifacts.ts`
- Update cleanup/storage/route/repository/publication tests

Red tests cover independent simultaneous grants, legacy initial grant, token expiry versus retention,
authorize before retention, foreign/deleted/expired behavior, owner-safe idempotent delete, safe paths,
all-grant invalidation, cleanup by retention, and populated dimensions/duration.

The signed binary route stays compatible. Publication creates stable descriptor rows and initial
grants in one transaction after files exist. Orphan reconciliation is idempotent.

## Gate 7: progress parser and live reporting

### 7.1 Pure incremental parser

Files:

- Add `apps/api/src/media/process/ffmpeg-progress.ts`
- Add parser tests

Red tests cover chunk boundaries, CRLF/LF, multiple records, malformed numbers, `out_time_us`,
`out_time_ms` compatibility, frame/speed, end record, and protocol exclusion from diagnostic output.

### 7.2 Runner/repository integration

Files:

- Extend process command/runner, workflow command, command recorder, job progress repository
- Add runner/repository/worker tests

Red tests cover optional observers, no observer for FFprobe/audio metadata stdout, lease/attempt
fencing, monotonic revision/percent/output duration, throttling, concurrent active outputs, phase
changes, recovery, conservative ETA range, and partial unsuccessful terminals.

### 7.3 Workflow instrumentation

Instrument compression, extraction, and comparison with explicit output descriptors and work bands.
Verify JSON status and event pages expose useful progress without stdout protocol leakage.

## Gate 8: multi-codec quality decision

### 8.1 Pure scene/metric/decision modules

Files:

- Extend `quality-comparison-plan.ts`
- Add `quality-comparison-metrics.ts`
- Add `quality-comparison-decision.ts`
- Add pure tests

Red tests cover exact auto center/start/effective duration, short overlap, frame/timecode resolution,
reference-reel filter/FFV1 output, per-codec preview plans, SSIM/PSNR parsing including infinity,
malformed metrics, domination, frontier ordering, balanced ties, and confidence thresholds.

### 8.2 Workflow/handler

Files:

- Refactor quality comparison workflow/handler and tests

Red tests prove one reference reel, mixed-codec candidates, bounded concurrency, shared frames,
ordered diagnostics, video-only aggregate estimates, preview/still publication only, entitlement for
every codec, cleanup on preparation/encode/metric failure, result compatibility fields, and progress.

Gate acceptance: a single upload/job compares VP9 and H.265 across three scenes, returns SSIM,
frontier/recommendation/confidence, and retains visual override artifacts.

## Gate 9: CLI and runtime skill

### 9.1 Billing and recovery commands

Files:

- Extend service/job command modules, CLI dispatch/help, and tests

Implement/test `billing status`, job list/lookup/events/watch, filters/cursor encoding, event dedupe,
fallback snapshot polling, partial decision behavior, and exactly one stdout envelope.

### 9.2 Inspect and plans

Files:

- Add `apps/cli/src/source-commands.ts`
- Add `apps/cli/src/execution-plan-commands.ts`
- Refactor media option parsing for reusable workflow options
- Add focused CLI tests

Implement/test inspect create/upload/resume, source get/delete, plan create/get/resolve/execute,
mandatory execute key, credit precision, guards, no-upload replay, no-wait/timeout, client reference,
matrix/scenes/metrics, and output-dir incompatibilities.

### 9.3 Artifact commands and materialization

Files:

- Refactor `apps/cli/src/artifact-command.ts` into reusable download/materialization seams
- Add materialization tests

Red tests cover ID authorization download, legacy URL compatibility, hash and byte mismatch, safe
names, duplicates, generated name collisions, symlink components/targets, pre-existing outputs,
same-process force backup/rollback, interruption cleanup, relative HTML/manifest, and remote retention.

### 9.4 Documentation/discovery

Files:

- Update `apps/cli/src/help.ts`, root `README.md`, shared/API capabilities
- Update `skill-bundle/entrypoint.md` and relevant references/drift tests
- Update exact OpenAPI operation/status test

The runtime skill must distinguish exact credit quotes, video-only size extrapolation, post-encode
byte enforcement, short-lived access grants, retention, and best-effort bundle rollback.

## Gate 10: full verification

Targeted red/green commands run throughout. Final repository commands, in order:

```text
pnpm format
pnpm check
pnpm build
```

Then run the deterministic local golden journey if its required FFmpeg encoders are available. Do
not run staging/production synthetic journeys. Record any unavailable prerequisite exactly.

Final manual audit:

- `git diff --check`;
- no `.env`, credential, token, signed URL fixture, SQLite file, or media output added;
- no application package imports another application;
- shared contracts import only through `@densio/shared`;
- OpenAPI documents every registered operation and status;
- CLI JSON commands emit one stdout success document;
- stderr events are JSONL and deduplicated;
- no function/file limit bypass or disabled lint rule;
- user-owned pre-existing changes remain present.
