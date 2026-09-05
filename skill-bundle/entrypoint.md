---
name: densio
description: Use when a user wants to compress or optimize videos for websites, compare visual quality and file sizes, extract screenshots, trim clips, prepare streaming video, or manage Densio jobs and outputs.
compatibility: Requires a terminal-capable agent, Node.js 22.18 or later, npm/npx, internet access, and email confirmation on first use.
---

# Densio

Help the user get usable video outputs. The API owns media inspection, codec policy, limits, exact credit quotes, and processing. Basic compression can follow this page without loading references.

## Keep this workflow consistent

Retain `data.cliVersion` as `CLI_VERSION` and `data.skillVersion` as `SKILL_VERSION` from the bootstrap response. Replace those placeholders in every command. Always use `npx --yes densio@CLI_VERSION` for this workflow, including reference requests. Keep an explicit `--api-url` and disposable `--credentials` path on every command when testing locally; preserve a user's custom API target in all requests.

Load a reference only when the task calls for it:

```sh
npx --yes densio@CLI_VERSION --json skill references/commands.md --skill-version SKILL_VERSION
```

Read its single `data.files` entry in memory; relative links resolve against that document's path. `data.references` lists available paths. On `SKILL_VERSION_CHANGED`, reload `skill`, replace the previous instructions and versions, and retain all existing resource IDs and retry keys. Do not mix versions or create replacement jobs merely because instructions changed. If loading fails, explain the failure and stop.

## First compression

1. Check sign-in. If unauthenticated, obtain the user's email and start login. Tell them to open the emailed link while the command waits; keep that process alive until confirmation. Never request tokens or read the user's mailbox. First registration creates “My organization” with a Free allowance automatically; no separate workspace setup or paid subscription is needed for default compression.

```sh
npx --yes densio@CLI_VERSION --json auth status
npx --yes densio@CLI_VERSION --json auth login EMAIL
```

2. Discover memberships. Use the existing explicit/local/server selection, or the sole membership for a new account. Ask only if the intended organization remains ambiguous. Disclose its name and pin its ID as `ORG_ID` across the flow. Invalid selections fail; never switch organizations to bypass missing resources or credits. Read scoped capabilities for defaults, limits, codecs, and shared credits.

```sh
npx --yes densio@CLI_VERSION --json orgs list
npx --yes densio@CLI_VERSION --org ORG_ID --json capabilities
```

3. Upload once and preserve `SOURCE_ID`. Choose fresh, stable `SOURCE_KEY` and `JOB_KEY` values for this intent and reuse each for its exact retries. Submit compression and save verified files into an appropriate `OUTPUT_DIR` in the user's project.

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json inspect FILE --idempotency-key SOURCE_KEY
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID compress --idempotency-key JOB_KEY --output-dir OUTPUT_DIR
```

Default compression produces VP9/WebM and H.265/MP4 at source resolution, with automatic audible-audio detection. Jobs wait by default. Use `--max-credits` for a known spending limit; respect existing authorization without adding a mandatory preview or approval step. `plans create` is an optional exact quote and configuration preview. Each job has an immutable execution plan internally.

If the source exceeds 30 fps, `MEDIA_DECISION_REQUIRED` means no job or credit hold was created. Recommend `cap-30` for ordinary web playback, honor a preference to preserve motion, and clarify if needed. Resubmit with `--frame-rate cap-30|preserve`; never silently change cadence.

4. Report output paths, source/output sizes, and the actual charged credits from the terminal receipt. Local materialization verifies byte counts and SHA-256 and includes relative-path HTML. Preserve the original file and existing outputs; use `--force` only for intentional replacement. Temporary remote outputs have retention deadlines; local downloads do not delete remote media.

With `--json`, stdout is one success document; stderr contains progress JSONL, early job IDs, or problems. A timeout/interruption leaves the remote job running. Preserve its job ID and resume with `jobs wait JOB_ID --output-dir OUTPUT_DIR`; do not submit again with a new key.

## Load further guidance as needed

- [Commands](references/commands.md): custom codecs, resize/crop, comparison, extraction, trim, optional plans, job recovery, and artifact operations.
- [Workflow guidance](references/workflows.md): advanced policy and interpretation, including requested 10-bit output, frame-rate choices, comparisons, and cleanup.
- [Organizations](references/organizations.md): multiple workspaces, membership, billing, and closure. Ordinary processing does not authorize account changes.
- [HLS](references/hls.md): streaming packages, rendition ladders, playback support, and downloads.
- [Storage](references/storage.md): durable hosting, public/private delivery, and storage connections.
- [Errors](references/errors.md): recovery for the actual returned error; retain job IDs and retry keys.

Before advanced processing, load Commands and the relevant workflow guidance. Read HLS for streaming and Storage for durable delivery. When the user explicitly requests 10-bit output, preserve that request and load the bit-depth guidance before submission.
