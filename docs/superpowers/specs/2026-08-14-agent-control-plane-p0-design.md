# Agent control-plane P0 design

## Goal

Make Densio a complete agent-first media control plane without turning it into a generic editor or
breaking the existing one-shot media commands. An agent must be able to upload a source once,
inspect trusted media facts, obtain an immutable and exact credit quote, resolve consequential
decisions, execute with enforceable guards, recover work without remembering a job identifier,
observe useful progress, and materialize verified artifacts into a project directory.

The same P0 also turns quality comparison into one useful decision product: one job compares a
bounded codec/CRF matrix over representative scenes, reports objective metrics, identifies the
Pareto frontier, and recommends a balanced candidate while retaining visual previews.

## Selected architecture

Add a parallel control-plane path beside the current `/v1/compress`, `/v1/extract-images`, and
`/v1/compare-quality` endpoints:

```text
Prepared source -> trusted inspection -> immutable execution plan -> guarded execution
                -> durable job -> events/status -> stable artifacts -> verified materialization
```

Existing one-shot endpoints and CLI commands remain supported. They continue to create an upload
job directly, while the new path creates an ordinary queued job from a prepared source. Both paths
converge on the current job worker, credit ledger, media handlers, artifact publisher, cancellation,
and terminal result contracts.

This additive shape avoids a risky rewrite of authentication, upload recovery, billing, and worker
leasing. It also keeps the API authoritative: the CLI never probes media, calculates credits,
resolves output names, selects policy, estimates confidence, or reconstructs legal actions.

## Alternatives considered

### Replace every one-shot command with the control plane immediately

This has the cleanest eventual resource model, but it would change all current upload, idempotency,
credit, decision, and CLI behavior at once. P0 keeps compatibility and lets the richer path prove
itself before internal consolidation.

### Represent inspection and planning as job workflows

This would reuse the worker queue, but it would pollute the exhaustive output-workflow contract and
charge or reserve credits for a control-plane read. Prepared sources and immutable plans are clearer
resources with different lifetimes.

### Return an opaque automatic optimization result

This is superficially simpler, but it prevents agents from auditing resolved defaults, budgeting,
approving decisions, or safely retrying. Plans are explicit, immutable, versioned, and digestible.

### Publish one preview for every scene and candidate

That grows to dozens of artifacts and commands. The selected comparison design builds one lossless
reference reel from the chosen scenes, then produces one preview and representative still per
candidate. Every candidate sees identical frames, cross-codec SSIM remains meaningful, and artifact
count stays bounded.

## Prepared sources

### Contract

`POST /v1/sources` accepts a filename and positive byte count. An optional `idempotency-key` header
is scoped to the authenticated account. The response is a prepared-source status containing a
stable `sourceId`, upload action, upload expiry, and source retention expiry.

`PUT /v1/sources/:id/upload` uses the existing bounded streaming upload rules. It stores and hashes
the source, moves the resource through `inspecting`, runs trusted FFprobe inspection, then returns a
`ready` source whenever the request remains connected. Inspection is persisted before execution so
maintenance can recover an interrupted request.

`GET /v1/sources/:id` returns one of:

- `awaiting-upload`, with an upload action;
- `inspecting`, with verified bytes and SHA-256;
- `ready`, with normalized inspection;
- `failed`, with a safe structured problem;
- `expired`, after bytes are no longer reusable.

Normalized inspection includes duration, encoded and display dimensions, rotation, rational and
decimal frame rate, primary video stream, audio streams, and all stream indexes/types/codecs. It is
metadata inspection, not a full-duration audio decode. `audio: auto` remains a deterministic
execution policy and does not change the exact compression credit quote.

`DELETE /v1/sources/:id` expires the resource early and removes its bytes idempotently. A job that
has already materialized its own hard link is unaffected.

### Persistence and storage

Add `prepared_sources` with owner, state, source declaration, verified bytes/hash, crash-safe upload
fields, inspection/error JSON, idempotency key, upload expiry, retention expiry, and timestamps.
Indexes support owner/idempotency lookup, owner history, and expiry maintenance.

Prepared bytes live only under a branded storage boundary:

```text
MEDIA_ROOT/sources/{sourceId}/input/source-video
MEDIA_ROOT/sources/{sourceId}/staging/*
```

No arbitrary path is persisted. Source IDs and filenames pass the same containment rules used for
job workspaces.

`SOURCE_TTL_SECONDS` defaults to 24 hours and is bounded from one hour to seven days. Upload expiry
continues to use `UPLOAD_TTL_SECONDS`. Maintenance expires abandoned uploads, resumes finalization
or inspection, and removes failed/expired source directories. Rows remain as safe audit records.

## Inspect, plan, resolve, execute

### Immutable execution plans

Use the name `ExecutionPlan` to avoid collision with the existing billing `Plan` type.

`POST /v1/execution-plans` accepts a ready `sourceId`, one existing workflow, its typed options,
and optional constraints. Compression and extraction options may be omitted; comparison remains
explicit. The server snapshots inspection and returns either:

- `decision-required`, with a typed decision and resolution action; or
- `ready`, with resolved options, exact quote, warnings, expected artifacts, and execution action.

Plans include:

- source ID, bytes, SHA-256, and inspection snapshot;
- requested and fully resolved options;
- exact credit units and decimal credits;
- available credits at planning time;
- expected artifact descriptors and logical filenames;
- typed warnings and required decisions;
- `media-policy@1` and `custom@1` profile identifiers;
- startup FFmpeg and FFprobe versions;
- a canonical SHA-256 `intentDigest`;
- creation/expiry timestamps and, after resolution, `supersedesPlanId`.

The digest covers source SHA-256, workflow, requested and resolved options, constraints, quote,
expected artifacts, and policy/profile versions. It excludes resource IDs, account balance, and
timestamps. Canonical JSON sorts object keys recursively so semantically identical server-resolved
intent hashes identically.

Plans are never mutated. `POST /v1/execution-plans/:id/resolve` accepts a frame-rate decision and
creates a new ready plan whose `supersedesPlanId` points at the decision-required plan. Retrying the
same idempotency key returns the same child plan; a conflicting choice returns an idempotency
conflict. Sources at or below 30 fps resolve omitted frame-rate policy to preserve. Higher-rate
sources require an explicit preserve or cap-30 choice before execution.

`GET /v1/execution-plans/:id` returns the durable snapshot or `expired` state. Plan expiry is the
earlier of `now + EXECUTION_PLAN_TTL_SECONDS` and source retention. The setting defaults to one hour
and is configurable from one minute to one day.

### Planning rules

Compression resolves default codecs, per-codec CRFs, audio policy, frame-rate policy, crop/scale,
output dimensions, output names, entitlements, and exact compression credit units using trusted
duration and dimensions. The expected manifest uses the current codec extensions/media types.

Extraction resolves interval, format, transform, expected image count, output dimensions, and the
archive descriptor. It rejects requests exceeding the configured image limit and quotes the current
fixed job charge.

Comparison normalizes legacy single-codec input and the new matrix input. It resolves scene
positions, transforms, candidate output names, entitlement, metrics, and exact policy charge. The
charge applies the existing resolution/duration formula to aggregate sampled candidate duration, so
the bounded legacy case still receives the minimum charge while a large matrix is not subsidized as
a single tiny job.
Frame-index positions remain supported: plan creation resolves them against the prepared source
rather than making the CLI do so.

### Guards and execution

`POST /v1/execution-plans/:id/execute` accepts:

- `maxCredits`, an optional exact pre-execution guard;
- `maxOutputBytes`, an optional hard post-encode aggregate artifact guard;
- `clientReference`, an optional account-unique recovery key.

The idempotency key remains an HTTP header and is mandatory for this spending operation. A ready,
unexpired plan may be executed multiple times with distinct keys. A retry with the same key and same
plan/guards/reference returns the existing job with `replayed: true`; reuse for different intent
conflicts. Plan create and resolve also accept optional idempotency headers and expose `replayed` so
agents can safely recover a lost response.

Credit guards use the same integer-unit authority as billing: one credit is 100 units, accepted
guards have no more than two decimal places, and `maxCredits * 100` must be a positive safe integer.
The API rejects excess precision instead of rounding a caller's budget up or down.

Credit truthfulness is strict: `maxCredits` is checked against the exact plan quote before a job is
created, and planned jobs reserve the exact quoted units. The worker freshly analyzes the job-owned
input and must derive the same units. A mismatch fails with `PLAN_DIVERGED` before encoding and
releases the reservation.

CRF encoding cannot promise an exact output size before work. `maxOutputBytes` is therefore labeled
`post-encode-hard-limit`, persisted on the job, and checked after every output is staged but before
any artifact row, access grant, URL, or published file is created. If the aggregate exceeds it,
staging is deleted, the job fails with `OUTPUT_SIZE_LIMIT_EXCEEDED`, and the exact quoted credits are
charged because the requested encode completed. This uses a dedicated terminal transition that
settles the existing reservation as usage; ordinary processing failures retain today's release
behavior. The API never presents this guard as an estimate or quote.

Execution creates an ordinary job, attempts to hard-link the prepared source into a job-owned
staging file, and falls back to a bounded streamed copy when linking is unsupported or crosses a
device. It verifies bytes and SHA-256 either way, then reuses crash-safe upload finalization to
publish the job input and queue it. The job-owned link or copy makes execution independent from later
source expiry. Public job upload is rejected for prepared-source jobs.

## Job discovery, events, and recovery

### Client references and idempotent replay

All media creation requests accept an optional `clientReference` at the root. It is printable,
bounded to 200 characters, and account-unique. Existing idempotency matching includes it.

The job-created response reports `replayed`. A first creation is `201` with `replayed: false`; an
idempotent replay is `200` with `replayed: true`. Upload details exist only while upload is legal.
This fixes the current misleading replay response that always claims `awaiting-upload`.

### Listing and lookup

`GET /v1/jobs` supports state, workflow, inclusive `since`, exact client reference, exact
idempotency key, limit 1-100, and opaque cursor filters. Results sort by `(createdAt DESC, id DESC)`
and use keyset pagination. Job summaries contain no terminal result payload, but include progress,
legal actions, correlation fields, and timestamps.

`GET /v1/jobs/lookup` accepts exactly one idempotency key or client reference and returns full job
status. Every query is owner-scoped; foreign and missing resources are indistinguishable.

### Events and legal actions

Add append-only `job_events` with a globally increasing integer sequence, job ID, event kind,
state, progress snapshot, attempt, optional output, and occurrence time. Global gaps are allowed;
ordering is monotonic per job. Creation, upload completion, state changes, decisions, artifact
publication, meaningful progress, and terminal transitions insert an event in the same immediate
database transaction as every DB-visible mutation. Filesystem work completes before the guarded
publication transaction; recovery reconciles any contained orphan file that exists without an
artifact row. An event cursor is independent from list cursors and filters only `sequence > after`.

`GET /v1/jobs/:id/events?after=N&limit=N` returns events in order and the next cursor. P0 is finite
polling, not SSE. Existing rows may have no historical events; status remains authoritative.

Every status and summary includes legal `actions` rather than requiring an agent to reconstruct
routes. Possible actions are upload, wait, cancel, decide-frame-rate, authorize-artifacts, and
materialize. Actions contain method, URL, and optional expiry.

## Progress

Keep `progressPercent` for compatibility and add a structured progress snapshot:

```text
phase: awaiting-upload | queued | inspecting | awaiting-decision | preparing | encoding |
       measuring | publishing | complete | failed | canceled | expired
percent: 0..100
revision: non-negative integer
attempt: non-negative integer
activeOutputs?: [{
  index, total, codec?, filename?, variantId?,
  processedDurationSeconds, totalDurationSeconds,
  etaSeconds?: { minimum, maximum }
}]
```

Each active output owns its processed/total duration, so parallel comparison variants are represented
without pretending they are one stream. The overall percent is a monotonic aggregate of completed
outputs plus active fractions. ETA is optional and appears only after observed progress/speed can
support a conservative range. `job_events.sequence` is the global polling cursor;
`progress.revision` is a per-job compare-and-set revision and the two are never interchangeable.

FFmpeg workflow commands use `-nostats -progress pipe:1`. The process runner incrementally parses
key/value records across chunk boundaries and keeps protocol text out of diagnostic output. A
structured internal observer reports `out_time_us`, frame, and speed. Writes are lease-owner guarded,
monotonic, and throttled to at most once per second unless phase/output/terminal state changes or
progress advances by at least one percentage point.

Overall bands are awaiting upload 0, queued 2, inspecting 5-10, work 10-95, and publishing 95-99.
Only successful completion is 100. Awaiting-decision remains at its inspection percent; failed and
canceled jobs retain their last partial percent; an upload that expires retains zero. Their phase
records the terminal reason. Workflow handlers label every active output. Recovery increments
attempt and never lets stale observers from an expired lease update a new attempt.

CLI wait/watch consumes the event endpoint, emits each event once to stderr JSONL, and preserves
exactly one final success envelope on stdout. Snapshot polling remains a fallback if an older server
does not expose events.

## Provenance and terminal receipts

Terminal job status includes a shared execution receipt with:

- source filename, declared/verified bytes, SHA-256, duration, encoded/display dimensions,
  rotation, rational frame rate, and stream facts;
- requested and resolved options, client reference, idempotency key, execution plan ID, source ID,
  policy/profile version, and intent digest when available;
- attempts, started/completed timestamps, FFmpeg/FFprobe versions;
- exact actual credits charged;
- artifact IDs, bytes, SHA-256, media metadata, and retention time.

Persist inspection/provenance snapshots and tool versions with the job. Credits charged are read
from the settled usage ledger so billing has one authority. Safe stored processor details are
preserved in failed problems; raw source paths, tokens, and unbounded stderr are never exposed.

Artifact publication populates width, height, and duration whenever the workflow already knows
them. No extra probe is required merely to fill metadata.

Compression result `html` becomes relative, deployable markup using logical filenames. A separate
optional `previewHtml` may use the initial temporary authorizations and is explicitly labeled
preview-only. Materialization writes relative markup; it never embeds bearer URLs in project files.

## Artifact lifecycle and materialization

### Stable descriptor versus authorization

Separate physical retention from signed-link lifetime. Artifact rows have `retainedUntil`; a new
`artifact_access_grants` table stores independent token hashes and access expiries. Cleanup keys off
retention. Signed download validates its matched grant expiry. Authorizing in two agents creates two
grants; neither invalidates the other.

A stable artifact descriptor contains ID, kind, logical filename, media type, bytes, SHA-256,
codec/dimensions/duration, availability state, retention time, authorize URL, and delete URL. For
compatibility, job results still include an initial `downloadUrl` and `expiresAt`, documented as an
ephemeral authorization.

`GET /v1/artifacts/:id` returns the owned stable descriptor. `POST /v1/artifacts/:id/authorize`
creates a short-lived independent grant and returns descriptor plus download action. It never extends
retention. Missing/foreign/deleted returns 404; owned retention expiry returns 410.
`DELETE /v1/artifacts/:id` safely unlinks, marks deletion, and invalidates all grants; it is
idempotent for the same owner.

Migration copies each legacy artifact token hash and expiry into an initial access-grant row, so old
persisted result URLs keep working until their original expiry. New status responses build stable
descriptors from artifact rows rather than trusting frozen result JSON. Legacy compression HTML is
returned as `previewHtml` only; materialization always regenerates relative markup from descriptors.

The existing signed binary route, range support, ETag, and cache behavior remain compatible.

### CLI materialization

The CLI supports:

```text
densio artifacts get ARTIFACT_ID
densio artifacts authorize ARTIFACT_ID
densio artifacts download ARTIFACT_ID --output PATH [--force]
densio artifacts delete ARTIFACT_ID
densio artifacts materialize JOB_ID --output-dir DIR [--force]
```

Legacy signed-URL download with explicit SHA-256 remains accepted.

Materialization fetches a succeeded status, validates unique safe logical filenames, includes its
generated HTML and manifest names in collision checks, rejects symlink targets or symlinked path
components, authorizes each artifact just before download, streams to same-filesystem temporary
files, verifies byte count and SHA-256, and publishes only after every file verifies. Each file
publication is atomic. Failure or interruption attempts in-process removal of temporaries and
rollback of paths created by this invocation. Forced replacement uses backups so that same-process
rollback can restore prior files. The bundle is not claimed to be crash-atomic; a process killed
between renames may leave a partial but individually verified bundle. Remote artifacts are never
deleted automatically.

For compression it also writes the relative HTML and a machine-readable materialization manifest.
The single success document contains the job, output directory, and verified local file receipts.

Media commands and `jobs wait` accept `--output-dir`; it is incompatible with `--no-wait`.

## Billing CLI

`densio billing status` calls the already shipped authenticated `GET /v1/billing/status`. Human
output includes plan, available/reserved/used/monthly credits, reset time, subscription status, and
renewal when present. JSON returns the server success envelope unchanged.

## Multi-codec, multi-scene quality decision

### Input compatibility and bounds

Keep the legacy `{ codec, crfs, position, durationSeconds, transform }` request. Add a matrix form:

```text
variants: 2..8 unique { codec, crf } pairs
scenes:
  { mode: auto, count: 2..5 }
  or { mode: positions, positions: 2..5 unique positions }
objectiveMetrics: [ssim] or [ssim, psnr]
durationSeconds: 1..3
transform?: existing transform
```

Legacy input normalizes to its candidate list and one scene. Matrix defaults to three uniformly
spaced temporal scenes. SSIM is mandatory because it is the recommendation axis; callers may
additionally request PSNR as informational output. No VMAF dependency is added.

CLI retains `--codec`, `--crf`, `--at`, and `--frame`. Matrix mode adds repeatable
`--matrix CODEC:CRF,CRF`, `--scenes N` or repeatable `--scene POSITION`, and `--metric ssim,psnr`.
Matrix and legacy selectors are mutually exclusive.

### Reference reel workflow

Auto scene target centers are `sourceDuration * (index + 1) / (count + 1)`. Effective duration is
`min(requestedDuration, sourceDuration)`, and each start is
`clamp(center - effectiveDuration / 2, 0, sourceDuration - effectiveDuration)`. Explicit seconds,
timecodes, and frames resolve through trusted inspection and use the same effective-duration bound.
Very short media may overlap samples; the response records actual starts/durations and lowers
confidence.

One FFmpeg preparation command trims each scene, applies the same resolved transform, resets
timestamps, concatenates video-only segments, and writes a staging-only FFV1 Matroska reference
reel. Each codec/CRF candidate encodes that reel, produces one middle still, and runs the requested
metrics against the same lossless reference. Reference and metric files never become artifacts.
Candidates run concurrently through the existing bounded process runner.

Estimated full video bytes are aggregate preview bytes divided by aggregate sample duration,
multiplied by trusted source duration. The result labels this a video-only sample-bitrate
extrapolation because the reference reel intentionally contains no audio; it never presents the
value as an exact total-file prediction.

SSIM parses a finite 0..1 aggregate. PSNR returns either positive finite dB or the explicit string
`"infinite"` for a perfect match and is informational. Malformed metric output fails safely rather
than fabricating a score.

### Pareto decision

A candidate is dominated when another candidate has no more estimated bytes and no lower SSIM,
with at least one strict advantage. Return the frontier sorted by bytes, then quality, then request
order.

Normalize frontier size utility and SSIM utility to 0..1 and choose the highest equal-weight
balanced score. Ties prefer fewer bytes, then higher SSIM, then request order. The result explains
this `balanced-ssim-size-v1` basis, returns the recommended candidate ID and all Pareto candidate
IDs, and keeps previews/stills for agent or human override.

Confidence is a transparent coverage heuristic, not statistical certainty: low for one scene or
temporal span below 0.25, medium for two scenes or span below 0.5, and high otherwise.

## CLI surface

The new primary flow is:

```text
densio inspect VIDEO [--idempotency-key KEY]
densio sources get|delete SOURCE_ID
densio plans create SOURCE_ID compress|extract-images|compare-quality [workflow options]
  [--idempotency-key KEY]
densio plans get PLAN_ID
densio plans resolve PLAN_ID preserve|cap-30 [--idempotency-key KEY]
densio plans execute PLAN_ID --idempotency-key KEY [--max-credits N] [--max-output-bytes N]
  [--client-reference REF] [--no-wait]
  [--timeout SECONDS] [--output-dir DIR] [--force]

densio jobs list [filters]
densio jobs lookup (--idempotency-key KEY | --client-reference REF)
densio jobs events JOB_ID [--after N] [--limit N]
densio jobs watch JOB_ID [--timeout SECONDS]
densio jobs wait JOB_ID [--output-dir DIR] [--force]
densio billing status
```

`inspect` creates, uploads, and returns the prepared source in one invocation, emitting the
resumable source ID to stderr as soon as it exists. `plans execute` returns/waits like current media
commands. All JSON commands keep one success document on stdout; status/progress remains JSONL on
stderr.

## Error and concurrency semantics

New typed problems include source not found/state/expiry/failure, plan not found/decision/expiry,
constraint exceeded, policy retired, option unsupported, plan divergence, output-size limit,
client-reference conflict, and artifact not found/expired. Existing upload, auth, entitlement,
billing, idempotency, and storage descriptors are reused.

Filesystem and SQLite cannot share a transaction. Source upload and source-to-job attachment use
persisted `finalizing` states and idempotent recovery. Execution links or copies before queueing.
Cleanup uses safe contained paths. Every ownership lookup is account-scoped.

State, event, progress, cancel, decision, and lease changes use compare-and-set conditions. Artifact
deletion may race a stream that is already open; that stream may finish, while future authorization
and download fail. No endpoint extends source, plan, or artifact retention in P0.

## Schema migration

Generate one forward Drizzle migration after updating the TypeScript schema. It adds:

- `prepared_sources` and `execution_plans` tables and indexes;
- job source/plan IDs, input mode, client reference, requested/resolved options, policy/profile,
  intent digest, quote/output guards, inspection/toolchain provenance, and progress snapshot fields;
- job history indexes and account-unique client reference;
- append-only `job_events` and `(job_id, sequence)` index;
- artifact retention plus media metadata columns and an independent access-grants table.

The migration backfills compatible defaults for existing rows. Existing jobs synthesize structured
progress and provenance from available columns when a new field is absent. No existing media or
artifact row is deleted during migration.

## Documentation and runtime skill

Update OpenAPI metadata/statuses for every operation, CLI help, root README, canonical
`skill-bundle/` entrypoint and command/error references, stable bootstrap drift tests, and
capabilities. Capabilities advertise prepared-source/plan support, policy/profile versions, TTLs,
comparison bounds/metrics, event polling, and artifact authorization lifetime.

The skill directs agents to discover capabilities, inspect once, plan before spending, enforce a
credit guard, use client references/idempotency, consume events, and materialize verified relative
artifacts. It explicitly distinguishes exact credits, extrapolated sizes, post-encode byte guards,
temporary preview URLs, and physical retention.

## Verification

Every production slice follows red/green/refactor TDD. Coverage includes:

- shared acceptance/rejection for source, plan, list/event/progress/provenance, artifact, matrix,
  decision, and materialization contracts;
- source storage containment, streaming/hash/size bounds, recovery, idempotency, inspection failure,
  ownership, expiry, and cleanup;
- immutable plan defaults, dimensions, entitlement, exact quote, canonical digest, decision child,
  guard truthfulness, expiry, link/copy execution, replay, and divergence;
- job list filters, owner isolation, equal-timestamp cursor correctness, lookup, replay status,
  atomic events, monotonic/throttled progress, stale lease rejection, and safe failed provenance;
- incremental FFmpeg progress parsing across chunk boundaries, output/ETA reporting, and no protocol
  pollution of diagnostics;
- independent artifact grants, retention separation, owner-safe delete, media metadata,
  expired/foreign behavior, and cleanup;
- materialization hash/byte verification, traversal/duplicates, collision policy, best-effort
  in-process rollback, interruption cleanup, relative HTML, and one-stdout-document behavior;
- legacy and matrix comparison normalization, deterministic auto scenes, short/near-EOF sources,
  reference reel, mixed codecs, SSIM/PSNR parsing, aggregate estimate, Pareto/ties/confidence,
  ordered commands, entitlement, and cleanup;
- billing status, source/plan/job/artifact CLI parsing, event deduplication, help, runtime-skill drift,
  route auth/statuses, and exact OpenAPI operation matrix;
- deterministic local golden journey: one upload -> inspect -> resolve/plan -> execute -> events ->
  authorize -> verified materialization -> delete.

Delivery uses dependency-ordered acceptance gates even though it lands as one P0 release: shared
contracts and migration; prepared sources; planning/execution; discovery/artifacts; progress and
provenance; comparison decision; CLI/materialization/docs; then the golden journey. A gate must be
green before code that depends on it begins.

At execute time the server accepts only the exact persisted policy/profile version. A newer current
policy does not silently reinterpret a plan: supported historical versions execute their snapshotted
resolved options, while a retired version returns `EXECUTION_PLAN_POLICY_RETIRED` and requires a new
plan. Tool-version drift alone is recorded in the receipt and does not invalidate a plan; fresh
analysis plus the quoted-unit divergence check remains the safety boundary.

After targeted cycles run `pnpm format`, `pnpm check`, and `pnpm build`. Synthetic staging and
production checks remain out of scope without explicit deployed credentials.

## Explicit non-goals

- No visual editor, timeline, folders, permanent media library, or DAM dashboard.
- No arbitrary remote URL ingestion, cross-user deduplication, or indefinite source retention.
- No raw FFmpeg arguments or generic command execution.
- No HLS/DASH/CDN hosting, webhooks, MCP-only interface, distributed queue, or object store in P0.
- No H.264, broad new transforms, watermarking, subtitles, compositing, or AI enhancement in P0.
- No VMAF dependency, semantic scene detection, custom metric weights, statistical confidence, or
  per-scene published artifact explosion.
- No exact ETA or exact CRF output-size promise.
