# Workflow guidance

Load this for advanced processing choices, quote previews, recovery, or cleanup.

## Inspect and submit

1. Read [references/organizations.md](organizations.md), authenticate if needed, and discover memberships with `orgs list`. Disclose the selected organization name/ID and pin `--org ORG_ID` on every command in the flow. Read scoped `capabilities` for its codecs, defaults, limits, and shared credits; `capabilities --public` is only anonymous common policy. If authentication is required, obtain the user's email, run `auth login EMAIL`, and ask them to open the emailed link and press **Confirm sign in** on the Densio website. Keep the CLI process running while they confirm. Never request or copy authentication tokens.
2. Upload once with `inspect FILE --idempotency-key KEY`. Preserve the returned source ID. Use `sources list` to discover retained uploads and `sources get SOURCE_ID` to inspect their current state. A ready source can be reused for comparison, compression, HLS, and image extraction without uploading again.
3. Submit the selected workflow with `jobs create SOURCE_ID WORKFLOW --idempotency-key KEY`. The API resolves defaults, validates intent, freezes an exact quote and immutable execution plan internally, and atomically reserves credits with job creation. Add `--max-credits` and `--max-output-bytes` for known user limits, and `--client-reference` for recovery. Respect existing spending authorization; do not introduce a mandatory preview or approval step.
4. If direct submission returns `MEDIA_DECISION_REQUIRED`, read `details.decision`, select the authorized frame-rate policy, and resubmit with `--frame-rate cap-30|preserve`. No job or credit hold was created. Do not silently alter cadence.
5. Use optional `plans create SOURCE_ID WORKFLOW` when a quote or resolved configuration preview is useful before spending. Review its requested/resolved options, exact quote, warnings, artifacts, and availability. `plans resolve` creates a child plan for a decision; `plans execute PLAN_ID --idempotency-key KEY` executes an available ready plan. Uploads, downloads, inspection, and storage lifecycle commands do not need plans.

The source, plan, job, and artifact are different identities. A source owns uploaded bytes. A plan freezes processing intent. Execution creates a job, atomically reserves the exact quote, and attaches the verified source before queueing. An artifact is an output produced by a job.

## Choose a workflow

- `compress`: default VP9/WebM plus H.265/MP4 outputs, source resolution, and automatic audible-audio detection. Set codec-specific CRFs or transforms when requested. AV1 is explicit and requires Basic or higher.
- Compression and comparison default to 8-bit, including for 10-bit sources. When the user explicitly requests 10-bit, pass `--bit-depth 10` (API `bitDepth: 10`). Keep the same bit depth for quality comparison and final compression. All selected VP9, H.265, and AV1 outputs use that depth; a 10-bit request is verified before publication and must never silently fall back to 8-bit. Bit depth alone does not enable HDR handling or recover detail absent from an 8-bit source.
- High-frame-rate compression: recommend `cap-30` for ordinary web playback; preserve cadence when the user values high-frame-rate motion. An omitted policy above 30 fps requires an explicit frame-rate decision. Do not silently change an explicit preference.
- `hls`: HEVC/H.265 Main10 SDR in fMP4 VOD, one shared AAC audio track, up to three source-aware renditions without upscaling, and one ZIP artifact. No H.264 fallback, VP9 HLS, or AV1 HLS in this release. Read [references/hls.md](hls.md) for CRF precedence, advanced ladders, playback compatibility, and package downloads.
- `extract-images`: timed frames packaged as a ZIP with a timestamp manifest; default JPEG every second.
- `compare-quality`: use one matrix of 2–8 unique codec/CRF candidates on 1–5 shared samples (default 3). One targeted sample is valid but gives weak coverage. SSIM is required; PSNR is optional. The server resolves explicit seconds, timecodes, and frame indexes once while planning. Prefer spread-out representative samples when a whole-video recommendation is needed.

For comparison, report codec/CRF, SSIM, optional PSNR, estimated size, Pareto membership, and the recommended variant with its confidence basis. Overlapping or clustered samples do not provide independent whole-video evidence. Size estimates extrapolate video-only sample bitrate; they are not guaranteed output sizes. Preserve requested codecs; clarify the final output set only when it remains materially ambiguous.

## Retry and recover safely

`jobs create` and `plans execute` wait by default and writes the resumable job ID to stderr immediately. Use `--no-wait` for detached work, then `jobs wait` or `jobs watch`. Both consume ordered events and confirm completion through authoritative status. Use `jobs list` and `jobs lookup` if the job ID was lost.

With `--json`, keep stdout and stderr separate: stdout contains one success document; stderr contains event JSONL, acknowledgements, or problems. A timeout or local interruption does not cancel the job. Cancel only within the user's authorization.

Retry an ambiguous submission, create, resolve, or execute using the same key and identical intent. A different execute key intentionally spends credits on another job. Never reuse a source key for changed file contents. Exact execute retries recover the existing job even after the source or plan expires; use a new plan and key only for intentionally new work.

Plan `state` remains `ready` or `decision-required`; `availability` separately reports `available`, `expired`, or `source-unavailable`. An unavailable plan has no execution/resolve action. To start new work after expiry, submit a new job from a retained ready source, optionally previewing a fresh plan first.

Execution holds the exact quote. Ordinary failures and cancellation release the reservation. A completed encode that exceeds the output-byte guard is charged even though no output is published. Read the required terminal `receipt` for actual billing, immutable source/intent facts, attempts, timestamps, observed tool versions/commands, and artifact hashes. Never fabricate execution fields absent from a job that did not start.

## Materialize and clean up

Results refer to stable artifact IDs; compression also supplies relative-path HTML. The terminal `receipt` records immutable evidence. The live `artifacts[]` inventory separately reports `available`, `deleted`, or `expired`. Only available artifacts can be downloaded.

Prefer `artifacts materialize JOB_ID --output-dir DIR`, or attach `--output-dir` to `jobs create`/`plans execute`/`jobs wait`. The CLI obtains fresh grants, verifies each byte count and SHA-256, preserves manifest filenames, and publishes a local bundle. Compression includes relative HTML. Existing local outputs are protected unless replacement with `--force` is intentional; multi-file replacement uses best-effort rollback, not a filesystem-wide atomic transaction.

For one output, use `artifacts download ARTIFACT_ID --output PATH`. Download grants are short-lived bearer secrets, not artifact identity. Never save them in long-lived HTML, logs, or project configuration.

Use `sources delete SOURCE_ID` to remove uploaded bytes when authorized. This blocks future attachment but does not delete input already attached to a job, generated artifacts, or receipts. Use `artifacts delete ARTIFACT_ID` for generated bytes; access is revoked immediately and failed physical removal is retried. Deletion is idempotent and retains explanatory tombstones.

Automatic cleanup remains active: abandoned uploads expire, interrupted preparation/inspection recovers, terminal scratch work is removed, grants expire independently, and source/output bytes are removed at retention deadlines. Local materialization does not automatically delete remote resources.

Physical cleanup waits for active upload/job writers and their child processes to finish. A source deletion receipt records logical deletion, not proof that an in-flight writer has already stopped. Pending cleanup survives restart; successfully cleaned resources are not repeatedly swept. For organization closure, wait for `deleted` before claiming byte cleanup is complete.

## Durable video delivery

Compression, trimming, and HLS output are temporary unless the submission selects storage (including organization defaults) or you explicitly run `videos save`. Public storage is the default and returns stable embed URLs. Use Densio-managed storage on paid plans, or connect S3-compatible output and private staging on every plan. Treat `ready` as the only publish/download state; `storing`, `storage-blocked`, and `visibility-changing` remain recoverable workflows. Consult `references/storage.md` for storage, source upload, video export, visibility, deletion, and verified download procedures.

## Trim an exact clip

Use `jobs create SOURCE_ID trim` for a standalone clip, or add `--trim-start` and
`--trim-end` to compression. Prefer `frame:N` positions for exact source pictures;
indexes start at zero, start is inclusive, and end is exclusive. Seconds and timecodes
are convenient alternatives. Omit end to keep the rest of the video. Standalone trim
requires one output codec and re-encodes with preserved cadence and the existing
even-dimension encoder normalization.
Consult `references/commands.md` for examples and inspect the resolved range and exact
quote. Do not describe re-encoding as lossless cutting.
