---
name: ffmpeg-api
description: Use when a user wants to compress or optimize video for the web, extract timed screenshots, compare CRF quality and estimated sizes, manage an asynchronous ffmpeg-api job, or download a temporary ffmpeg-api artifact through the agent-first CLI.
---

# FFmpeg API

Use the `ffmpeg-api` CLI instead of constructing FFmpeg commands or calling the HTTP API directly. The server owns codec policy, inspection, audio decisions, queueing, and cleanup.

## Start safely

1. Run `ffmpeg-api --json capabilities` before choosing flags. Treat its plan, codec, CRF, duration, and upload limits as authoritative.
2. If the command returns `AUTH_REQUIRED`, ask the user for their email and run `ffmpeg-api --json auth login EMAIL`. Tell them to open the link sent by email. The CLI polls until confirmation; never ask for, print, or copy login tokens.
3. Keep stdout and stderr separate. With `--json`, stdout is exactly one schema-versioned success document. Progress is NDJSON on stderr.
4. Read [references/commands.md](references/commands.md) before constructing media or transform flags.

## Choose the workflow

- Use `compress` for ready-to-publish video. With no media flags it creates both VP9/WebM and H.265/MP4, preserves source resolution, detects audible audio, and returns signed links plus an HTML `<video>` snippet.
- Use `extract-images` for a ZIP of timed frames. The default is JPEG every 1 second.
- Use `compare-quality` before a final encode when the preferred CRF is unclear. Supply 2–8 CRFs and optionally choose seconds, timecode, or an exact zero-based frame. Samples default to 1 second and may be explicitly extended only through 3 seconds.
- AV1 is explicit and available on every plan. Do not silently replace a requested AV1 workflow with another codec.

## Manage asynchronous work

Media commands wait by default. Prefer this when the caller can remain connected.

Use `--no-wait` for long-running or externally orchestrated work. Preserve `data.jobId` and `data.resumeCommand`, then resume with `ffmpeg-api --json jobs wait JOB_ID`. An interrupted wait does not cancel server work. Cancel only when the user explicitly requests it with `jobs cancel`.

Supply one stable `--idempotency-key` when retrying creation after a network ambiguity. Reuse it only with the identical file and options. Never retry by creating several unkeyed jobs.

Job creation automatically reserves the 0.05-credit minimum. After trusted media inspection, compression adjusts that reservation for duration, average input/output resolution, and output codec count before encoding. A five-minute 1080p source costs 1 credit per output codec; charges round up to 0.05 credits. Image extraction and quality comparison currently cost 0.05 credits. The flow never prompts for a quote or confirmation. Success consumes the final reservation; failure, cancellation, upload expiry, or insufficient post-analysis credits releases it.

## Consume results

- Compression: use each `data.result.artifacts[]` entry's `downloadUrl`, `sha256`, and `expiresAt`; also return `data.result.html` when useful. `data.result.commands` contains the exact executable, argv, and safely escaped display form used by the server.
- Extraction: use `data.result.archive.downloadUrl` and its SHA-256.
- Comparison: present each variant's CRF, preview/still URLs, and `estimatedFullVideoBytes`. Describe the estimate as coarse sample-bitrate extrapolation, not a guaranteed final size.
- Download before `expiresAt`. Use `ffmpeg-api --json artifacts download SIGNED_URL --output PATH --sha256 HEX`; the CLI streams to a temporary file, verifies SHA-256, then renames atomically.

Treat signed artifact URLs as temporary bearer secrets. Avoid copying them into long-lived logs or documents, and disclose that command arguments may be visible in shell history or process inspection. Source uploads and intermediates are deleted after terminal processing; outputs expire on the server.

## Recover from failure

Read [references/errors.md](references/errors.md) when a command fails. Follow `code`, `retryable`, `suggestedAction`, and the stable exit code instead of matching human text. Do not retry validation, entitlement, hash-mismatch, or media-encoding failures unchanged.
