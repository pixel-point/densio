---
name: densio
description: Use when a user wants to compress or optimize video for the web, extract timed screenshots, compare CRF quality and estimated sizes, manage an asynchronous Densio job, or download a temporary Densio artifact through the agent-first CLI.
---

# Densio

Use the CLI through `npx densio` instead of constructing FFmpeg commands or calling the HTTP API directly. The server owns codec policy, inspection, audio decisions, queueing, and cleanup.

## Start safely

1. Run `npx densio --json capabilities` before choosing flags. Treat its plan, codec, CRF, duration, and upload limits as authoritative.
2. If the command returns `AUTH_REQUIRED`, ask the user for their email and run `npx densio --json auth login EMAIL`. Tell them to open the link sent by email. The CLI polls until confirmation; never ask for, print, or copy login tokens.
3. Keep stdout and stderr separate. With `--json`, stdout is exactly one schema-versioned success document. Progress is NDJSON on stderr.
4. Read [references/commands.md](references/commands.md) before constructing media or transform flags.

## Choose the workflow

- Use `compress` for ready-to-publish video. With no media flags it creates both VP9/WebM and H.265/MP4, preserves source resolution, detects audible audio, and returns signed links plus an HTML `<video>` snippet.
- Compression sources above 30 fps require an explicit cadence decision before encoding. Recommend `cap-30` for typical web video; preserve the source for sports, gameplay, smooth screen recordings, slow-motion material, or when the user asks for 60 fps.
- Use `extract-images` for a ZIP of timed frames. The default is JPEG every 1 second.
- Use `compare-quality` when the user complains about output quality, asks to increase or decrease quality, explicitly requests a comparison, or wants output-size estimates at different quality levels. Compare both H.265 and VP9 by default; the command accepts one codec at a time, so run a separate comparison for each. Respect an explicit request for different or fewer codecs. Unless the user specifies CRFs, choose seven values independently for each codec, centered on that codec's default CRF and separated by increments of 2: three below, the default, and three above. Keep automatically selected values within both the preferred 20–50 comparison window and the codec-specific range returned by `capabilities`. Go outside 20–50 only when the user asks, and never exceed the codec's supported range. Optionally choose seconds, timecode, or an exact zero-based frame. Samples default to 1 second and may be explicitly extended only through 3 seconds.
- AV1 is explicit and requires Basic or higher. Do not silently replace a requested AV1 workflow; refresh capabilities and report the upgrade requirement when the current plan is Free.

## Manage asynchronous work

Media commands wait by default. Prefer this when the caller can remain connected.

Use `--no-wait` for long-running or externally orchestrated work. Preserve `data.jobId` and `data.resumeCommand`, then resume with `npx densio --json jobs wait JOB_ID`. An interrupted wait does not cancel server work. Cancel only when the user explicitly requests it with `jobs cancel`.

If a wait returns `state: "awaiting-decision"` with `decision.kind: "frame-rate"`, show the detected source rate and ask the user whether to apply the recommended 30 fps cap or preserve it. Resume the same job with `npx densio --json jobs decide-frame-rate JOB_ID cap-30` or `npx densio --json jobs decide-frame-rate JOB_ID preserve`; never create a replacement job. When the user's intent is already explicit, pass `--frame-rate cap-30|preserve` to `compress` so the job does not pause.

Supply one stable `--idempotency-key` when retrying creation after a network ambiguity. Reuse it only with the identical file and options. Never retry by creating several unkeyed jobs.

Job creation automatically reserves the 0.05-credit minimum. After trusted media inspection and any required high-frame-rate decision, compression adjusts that reservation for duration, average input/output resolution, and output codec count before encoding. A five-minute 1080p source costs 1 credit per output codec; charges round up to 0.05 credits. Image extraction and quality comparison currently cost 0.05 credits. There is no quote confirmation. Success consumes the final reservation; failure, cancellation, upload expiry, or insufficient post-analysis credits releases it.

## Consume results

- Compression: use each `data.result.artifacts[]` entry's `downloadUrl`, `sha256`, and `expiresAt`; also return `data.result.html` when useful. `data.result.commands` contains the exact executable, argv, and safely escaped display form used by the server.
- Extraction: use `data.result.archive.downloadUrl` and its SHA-256.
- Comparison: combine all requested codec variants into one Markdown table with the columns `CRF`, `Estimated full size`, `Codec`, and `Preview`, in that order. Use `data.result.codec` for the codec, format `estimatedFullVideoBytes` as a human-readable size, and make `preview.downloadUrl` a clickable preview link. Describe the size as a coarse sample-bitrate extrapolation, not a guaranteed final size.
- Base downloaded filenames on the original upload's stem. Normalize the stem to lowercase ASCII kebab-case by replacing runs of non-alphanumeric characters with one hyphen and trimming leading or trailing hyphens; only lowercase letters, numbers, and hyphens are allowed. Preserve the downloaded artifact's extension, and append a kebab-case codec, CRF, or other differentiator when multiple artifacts would otherwise have the same name. For example, `My Video (Final) 02.mov` becomes `my-video-final-02.webm`.
- Download before `expiresAt`. Use `npx densio --json artifacts download SIGNED_URL --output PATH --sha256 HEX`; the CLI streams to a temporary file, verifies SHA-256, then renames atomically.

Treat signed artifact URLs as temporary bearer secrets. Avoid copying them into long-lived logs or documents, and disclose that command arguments may be visible in shell history or process inspection. Source uploads and intermediates are deleted after terminal processing; outputs expire on the server.

## Recover from failure

Read [references/errors.md](references/errors.md) when a command fails. Follow `code`, `retryable`, `suggestedAction`, and the stable exit code instead of matching human text. Do not retry validation, entitlement, hash-mismatch, or media-encoding failures unchanged.
