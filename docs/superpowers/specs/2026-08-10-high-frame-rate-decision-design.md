# High-frame-rate compression decision design

## Goal

Prevent accidental web delivery of high-frame-rate video by pausing compression jobs whose
source frame rate exceeds 30 fps until the caller chooses either to preserve the source cadence or
cap it at 30 fps. Keep low-frame-rate compression automatic and let automated callers preselect a
policy when creating the job.

## Selected design

Add an optional compression-only `frameRate` policy with two explicit values:

- `{ "mode": "preserve" }` keeps the source timing.
- `{ "mode": "cap", "maximum": 30 }` reduces only sources above 30 fps.

When the policy is omitted, the worker probes the uploaded source before reserving the final job
cost. Sources at or below 30 fps continue automatically with preserve behavior. Sources above 30
fps move to a durable `awaiting-decision` state. Their job status includes the exact probed rational
frame rate, the recommended cap policy, and the authenticated URL for submitting the choice.

The source must be uploaded before this decision because the API cannot trust a filename or
caller-supplied frame-rate claim. No video encoder runs before the choice. Callers that already know
their desired behavior can include `frameRate` in the original compression request and bypass the
pause.

## Alternatives considered

### Always cap high-frame-rate sources

This minimizes file size and encoding work but silently removes motion information from sports,
gameplay, screen recordings, and footage intended for slow motion. It does not satisfy the explicit
consent requirement.

### Prompt inside the CLI before upload

This would avoid uploading before the choice, but the CLI deliberately does not require local
FFmpeg, browsers do not expose a reliable standard frame-rate property, and API callers would have
no equivalent protection. It would also make JSON and agent automation depend on interactive stdin.

### Server-side probe followed by a durable decision

This is the selected approach. It uses the existing trusted media inspection, works for every API
client, survives CLI interruption, and keeps the decision machine-readable. The CLI presents the
decision and exits instead of blocking on stdin so an agent can ask its user and resume safely.

## Public contracts

`CompressionOptionsSchema` gains the optional `frameRate` union described above. The cap maximum
is the literal value 30 in this version; supporting arbitrary target rates is intentionally out of
scope.

`JobStateSchema` gains `awaiting-decision`. A job in that state has `progressPercent: 5` and a
`decision` object with:

- `kind: "frame-rate"`
- `source`: `numerator`, `denominator`, and derived `framesPerSecond`
- `recommended`: `{ "mode": "cap", "maximum": 30 }`
- `submitUrl`: the authenticated decision endpoint

`POST /v1/jobs/:id/frame-rate-decision` accepts `{ "frameRate": <policy> }` and returns the current
job status. The first valid decision atomically stores the policy in the persisted compression
options, clears the pending decision, and requeues the job. Retrying the same decision is
idempotent, including after processing has begun. A conflicting second decision returns the
existing job-state conflict response. The endpoint rejects non-compression jobs and jobs that have
never requested a frame-rate decision.

Cancellation remains valid while awaiting a decision and releases the minimum credit hold and
removes the uploaded workspace just as queued cancellation does.

## Worker and persistence flow

1. Job creation stores the optional frame-rate policy in the existing options JSON.
2. Upload finalization queues the job as today.
3. The worker claims the job and the compression handler probes dimensions, duration, audio, and
   rational frame rate.
4. With an explicit policy, or with an omitted policy and a source at or below 30 fps, analysis
   returns its normal metered result.
5. With no policy and a source above 30 fps, analysis returns a typed decision-required outcome.
6. The worker atomically changes `analyzing` to `awaiting-decision`, stores the decision JSON,
   releases its lease, and completes the attempt with a `decision-required` outcome. It keeps the
   source workspace and minimum credit hold.
7. Decision submission updates the options and changes `awaiting-decision` to `queued`.
8. The worker claims and analyzes the job again. The stored explicit policy prevents another pause,
   and normal credit reservation and processing continue.

The database adds the new job state, nullable `decision_json`, and the new job-attempt outcome.
Re-analysis after the decision is deliberate: it keeps the existing process-analysis identity
guarantee and avoids persisting a second resumable analysis format.

## FFmpeg behavior

Preserve mode adds no frame-rate filter. Cap mode appends an `fps` video filter only when the
source rational rate exceeds 30 fps.

To retain regular cadence, the target is the highest integer-divisor cadence no greater than 30:
the divisor is `ceil(source fps / 30)` and the reduced target rational is
`source numerator / (source denominator * divisor)`. This maps 60 to 30, 60000/1001 to
30000/1001, 50 to 25, and 120 to 30. FFmpeg receives the exact rational expression, avoiding
floating-point command arguments. Crop and scale filters remain ordered before `fps`.

The filter drops frames while preserving presentation duration; audio handling is unchanged. File
size and encoding work should decrease, but no exact size reduction is promised because the codecs
use quality-based encoding.

## CLI behavior

Compression accepts `--frame-rate preserve|cap-30`. Omitting it enables the server-side decision.
The option is documented as compression-only.

Job polling treats `awaiting-decision` as an actionable return, not as a terminal failure or a
state to poll forever. JSON mode preserves its one-document stdout guarantee and returns the full
status. Human output shows the detected frame rate, recommends the cap, and prints these commands:

```text
densio jobs decide-frame-rate JOB_ID cap-30
densio jobs decide-frame-rate JOB_ID preserve
```

`jobs decide-frame-rate` submits the choice and then behaves like `jobs wait` by default. It accepts
the existing `--timeout`; no new interactive stdin dependency is introduced.

## Errors and concurrency

All state changes use compare-and-set conditions. If cancellation, a duplicate submission, and a
worker transition race, exactly one state transition wins. Same-value decision retries return the
current status; different-value retries receive a 409 conflict. Invalid decision JSON receives the
standard invalid-request problem. Repository failures use the existing storage-error mapping.

An `awaiting-decision` job is not claimable and has no active lease, so worker recovery ignores it.
There is no new decision expiry in this feature; users can cancel abandoned jobs, matching the
existing ability for queued jobs to wait while workers are unavailable.

## Documentation and verification

Update the OpenAPI contract, root README, CLI help, and downloadable skill bundle so agents know
that omitted high-frame-rate policy can require a follow-up decision.

Tests cover:

- shared policy and job-status schema acceptance and rejection;
- exact 60-to-30 and 60000/1001-to-30000/1001 FFmpeg filters, no upsampling, and filter order;
- compression analysis pausing only omitted policies above 30 fps;
- atomic worker pause, cancellation, recovery isolation, idempotent decision submission, and
  conflicting decisions;
- route authentication, request validation, response contracts, and OpenAPI exposure;
- CLI option parsing, actionable polling return, JSON output, human commands, and decision resume;
- durable adapter behavior proving that no encoder command runs before consent and the selected
  policy reaches every requested codec.

After targeted red/green cycles, run `pnpm lint`, `pnpm format`, `pnpm test`, and `pnpm typecheck`.
