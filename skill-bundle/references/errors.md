# Error and retry playbook

JSON problems include `code`, `retryable`, `suggestedAction`, `correlationId`, and sometimes `jobId`. Do not match human wording.

For an HLS job failure with `HLS_SCRATCH_LIMIT_EXCEEDED`, free server disk space or have the operator increase `HLS_MAX_SCRATCH_BYTES` before starting an authorized retry. Package files and their ZIP both occupy scratch space; do not silently reduce quality or change the requested ladder.

| Exit | Meaning                 | Action                                                       |
| ---: | ----------------------- | ------------------------------------------------------------ |
|    0 | Success                 | Parse the one stdout document.                               |
|    2 | Usage                   | Correct arguments before retrying.                           |
|    3 | Authentication          | Complete login for the intended account/API.                 |
|    4 | Plan, limit, or credits | Inspect the quote, capability, or guard failure.             |
|    5 | Remote/media failure    | Follow the structured problem.                               |
|    6 | Network or wait timeout | Resume or retry identical intent with the same key.          |
|  130 | Interrupted             | Resume with the supplied job command; server work continues. |

## Skill loading

- `SKILL_VERSION_CHANGED`: reload `skill` with the pinned CLI, read the new entrypoint, and use its `skillVersion` on subsequent reference requests. Preserve IDs and retry keys; changing instructions does not authorize new processing.
- `CLI_USAGE_ERROR` for a skill path: use an exact path from `data.references`, with at most one document per request.
- Missing CLI/version metadata or `CLI_INVALID_RESPONSE`: stop and report the compatibility failure. Do not fall back to remembered instructions.

## Source and planning failures

- `ORGANIZATION_NOT_FOUND` (404): missing organization or no current membership. Check the intended ID; do not retry under another default.
- `ORGANIZATION_ACCESS_DENIED`, `ORGANIZATION_OWNER_REQUIRED` (403): stop and have an authorized member perform the requested action. Do not self-promote.
- `ORGANIZATION_NOT_ACTIVE` (409): only retained closure status is available. Use `orgs get ORG_ID`.
- `ORGANIZATION_OWNER_TRANSFER_REQUIRED`: owners must explicitly transfer ownership before leaving/removal.
- `ORGANIZATION_INVITATION_EXPIRED` (410), `ORGANIZATION_INVITATION_UNAVAILABLE`: inspect recipient identity and invitation status. Replaying an accepted invitation cannot restore a removed membership.
- `ORGANIZATION_RATE_LIMITED` (429): honor the retry guidance; defaults and no-op invitation retries do not consume creation quota.
- `ORGANIZATION_BILLING_BUSY` (409): preserve the checkout key, inspect billing, and retry only the same intended operation. Do not abandon uncertain Stripe state by changing keys. For persistent uncertainty, ask a platform operator to run `api-admin billing inspect ORG_ID` and `api-admin billing reconcile ORG_ID` on the server. Reconciliation never creates a replacement checkout; absent evidence requires provider investigation. Contact recovery uses the same saved email, not a different contact intent.
- `ORGANIZATION_DELETION_BLOCKED` (409): inspect blocker counts. Do not automatically cancel jobs/subscriptions, delete uploads, or change billing to bypass them.

- `AUTH_REQUIRED`, `AUTH_CHALLENGE_EXPIRED`: complete or restart human email login.
- `SOURCE_NOT_FOUND`, `SOURCE_STATE_CONFLICT`, `SOURCE_UPLOAD_EXPIRED`: inspect the source ID/state. Resume recoverable finalization; declare a new source only when necessary.
- `SOURCE_IDEMPOTENCY_CONFLICT`: the source key has different declaration intent. Recover the original or use a new key for intentionally different input.
- `SOURCE_UPLOAD_TOO_LARGE`, `SOURCE_UPLOAD_SIZE_MISMATCH`, `SOURCE_INSPECTION_FAILED`: correct the file, declaration, or capability limit. Do not loop unchanged.
- `EXECUTION_PLAN_NOT_FOUND`, `EXECUTION_PLAN_STATE_CONFLICT`, `PREPARED_SOURCE_UNAVAILABLE`: read plan/source state and follow advertised actions.
- `MEDIA_DECISION_REQUIRED` (409): no job or credits were reserved. Read `details.decision.choices`, then resubmit directly with the authorized `--frame-rate preserve|cap-30`. Public planning is optional.
- `HLS_SOURCE_UNSUPPORTED` (422): use a progressive SDR source with current inspection metadata; HDR, interlaced sources, and oversized packages are unsupported. Do not silently tone-map or switch codecs.
- `EXECUTION_PLAN_DECISION_REQUIRED`: resolve the planning decision, then execute the returned child plan.
- `EXECUTION_PLAN_EXPIRED`: for new work, create a fresh plan from a retained ready source and review its quote again.
- `PLAN_ENTITLEMENT_REQUIRED`, `CODEC_NOT_ENTITLED`, `DURATION_LIMIT_EXCEEDED`: refresh authenticated capabilities. Do not silently change the requested codec or buy an upgrade.
- `MAX_CREDITS_EXCEEDED`: lower the work or obtain authorization before raising the caller's guard.
- `OUTPUT_LIMIT_EXCEEDED`: reduce the output count, such as by increasing the extraction interval.

## Execution and recovery failures

- `CREDITS_EXHAUSTED`: the selected organization has insufficient shared unreserved credits. No new encode starts. Wait for reset, reduce requested work, or request an authorized organization upgrade; do not switch organizations.
- `IDEMPOTENCY_CONFLICT`: the key belongs to different semantic intent. Recover the original request or use a different intentional key.
- `CLIENT_REFERENCE_CONFLICT`: look up the existing job or choose a new intentional reference.
- `PLAN_DIVERGED`: fresh inspection or analyzed cost differs from frozen intent. Encoding does not proceed. Investigate the source and create/review a fresh plan before another execution.
- `OUTPUT_SIZE_LIMIT_EXCEEDED`: encoding completed, but aggregate output bytes exceeded the guard. No output is published and the exact quote is charged. Change options/limit only within spending authorization.
- `MEDIA_PROCESS_FAILED` and deterministic media validation errors: inspect diagnostics and suggested action; do not retry unchanged blindly.
- `OUTPUT_BIT_DEPTH_MISMATCH`: the encoded video could not be verified at the requested bit depth. No artifacts are published. Inspect the recorded encoder/probe diagnostics; do not silently retry at 8-bit or describe the failed output as 10-bit.
- `CLI_WAIT_TIMEOUT`, `CLI_INTERRUPTED`: resume the existing job; do not create a duplicate.
- `CLI_NETWORK_ERROR`: retry with bounded backoff. Preserve the same creation/execution key after an ambiguous response.
- `CLI_INVALID_RESPONSE`: stop rather than guessing an older contract or dropping required receipt fields. Report the correlation ID.

## Artifact failures

- `ARTIFACT_NOT_FOUND`, `ARTIFACT_EXPIRED`: inspect the owned descriptor and terminal receipt. Deleted/expired output cannot be restored by minting a grant. Reprocessing spends credits and needs authorization.
- `ARTIFACT_HASH_MISMATCH`, `ARTIFACT_SIZE_MISMATCH`: staged bytes are discarded. Re-authorize once; stop and report persistent mismatch.
- `ARTIFACT_DESTINATION_EXISTS`, `ARTIFACT_OUTPUT_UNSAFE`: choose a safe empty path, or intentionally replace with `--force`. Do not bypass symlink/filename checks.
- A deletion storage failure may occur after access has already been revoked. Retry the same deletion; automatic cleanup also retains its retry marker.

Retry only retryable failures or ambiguous client network interruptions. Keep keys and job IDs; retain correlation IDs for operator investigation. Never turn retry permission into authorization for additional spending, deletion, or account changes.

## Video storage recovery

- `STORAGE_NOT_CONFIGURED`, `STORAGE_UPGRADE_REQUIRED`: choose temporary or active customer storage, or upgrade managed capacity.
- `STORAGE_QUOTA_EXCEEDED`: export/delete videos or wait for a plan correction; encoded artifacts remain recoverable until the original deadline.
- `STORAGE_PROVIDER_UNAVAILABLE`, `STORAGE_BUSY`: inspect the transfer/operation and retry the same intent. Retry never re-encodes or charges credits.
- `STORAGE_CONNECTION_UNAVAILABLE`, `STORAGE_PRIVATE_STAGING_REQUIRED`: validate or rotate a connection with private staging.
- `STORAGE_ENDPOINT_REJECTED`, `STORAGE_PERMISSION_DENIED`: correct the safe HTTPS public endpoint, DNS, or provider policy and run `storage test CONNECTION_ID`.
- `STORAGE_OBJECT_CHANGED`, `STORAGE_DELETION_BLOCKED`: provider bytes or deletion could not be proven. Do not treat the operation as complete; inspect its cleanup obligations.
- `STORAGE_RECOVERY_EXPIRED`: the 24-hour storage recovery window ended; create new encoding work only when authorized; retained durable videos can still be exported without re-encoding.
- `STORAGE_ACCESS_EXPIRED`, `STORAGE_UPLOAD_LIMIT_EXCEEDED`: resume the existing direct upload or wait for unfinished sessions to be cleaned before creating another.
- `STORAGE_TRANSFER_NOT_FOUND`, `VIDEO_NOT_FOUND`, `STORAGE_INVALID_STATE`: refresh the scoped catalog and act only on its current IDs/state.

## Trim recovery

- `INVALID_REQUEST` (400) for a trim: choose a nonempty range within the source.
  Frames must be safe nonnegative integers; start is inclusive and end exclusive.
  An end-only CLI flag requires `--trim-start`. Standalone output needs one codec.
- `TRIM_TIMELINE_UNSUPPORTED` (422): exact boundaries cannot be resolved from the
  source timestamps/durations. Use a source with a valid timeline; do not substitute
  average FPS or silently change the requested frame range.
- `TRIM_OUTPUT_INVALID`: the staged clip failed frame-count/timing verification and
  was not published. Retain the job ID for diagnosis; ordinary job failure releases
  the reservation.
- `TRIM_SELECTED_STREAMS` is a plan warning: only primary video and the first audio
  stream are retained; subtitles and additional tracks are omitted.

A wait deadline covers HTTP requests, response bodies, authentication refresh and retry sleeps. Exit 6 leaves the server job running; resume with its job ID. Invalid local options return exit 2 before authentication, with schema field paths when available.

Uncertain multipart creation requires platform-operator recovery: `api-admin storage inspect ORG_ID`, then `api-admin storage reconcile ORG_ID OBJECT_ID`. These are not end-user CLI commands. Reconciliation can adopt one exact-key session after checking durable ownership. Empty inventories, multiple sessions, live writers, changed ownership, or an existing unverified object remain unresolved; do not create a replacement upload or delete provider objects to bypass recovery.
