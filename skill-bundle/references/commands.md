# Command reference

Use the bootstrap response's `cliVersion` for `CLI_VERSION` in every example. Load one document with `npx --yes densio@CLI_VERSION --json skill references/commands.md --skill-version SKILL_VERSION`. On `SKILL_VERSION_CHANGED`, reload the entrypoint and preserve all existing job IDs and retry keys.

Use `--json` for agent output. The API target precedence is `--api-url`, `DENSIO_API_URL`, config, then `https://api.densio.sh`. For local testing always pass `--api-url` and a disposable `--credentials` path. Credentials are owner-only and bound to the normalized API origin.

## Reusable uploads

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json inspect input.mp4 --idempotency-key source/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json sources list --state ready --limit 25
npx --yes densio@CLI_VERSION --org ORG_ID --json sources list --since 2026-07-01T00:00:00.000Z --cursor CURSOR
npx --yes densio@CLI_VERSION --org ORG_ID --json sources get SOURCE_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json sources delete SOURCE_ID
```

`inspect` declares the filename and byte count, reports a resumable source ID, streams the upload, and returns trusted inspection. A ready replay does not upload again. States are `awaiting-upload`, `finalizing`, `inspecting`, `ready`, `failed`, `deleted`, and `expired`. Lists include tombstones; cursors are opaque and organization/filter scoped.

Deleting a source prevents future execution against it but preserves existing attached job inputs and outputs. Artifact deletion is separate.

Deletion revokes access immediately; physical cleanup waits for active writers and is retried automatically. Do not report that all organization bytes are gone until `orgs get ORG_ID` reports `deleted`.

## Submit directly

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID compress --idempotency-key compress/task-123 --output-dir ./video
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID extract-images --interval 2 --idempotency-key images/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID compare-quality --matrix h265:26,30 --idempotency-key compare/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID hls --destination densio --idempotency-key hls/task-123 --until stored
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID hls --h265-crf 28 --rate-control crf --idempotency-key hls/task-456 --no-wait
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID hls
```

Direct submission starts processing without public plan creation. All media workflows share required retry keys, `--max-credits`, `--max-output-bytes`, `--client-reference`, default waiting, `--no-wait`, `--timeout`, and verified `--output-dir` materialization. `--until stored` requires compression, trimming, or HLS with durable storage. Use an optional plan when a preview is useful.

Every workflow accepts `--options-file PATH` containing just its options JSON (maximum 64 KiB). It excludes individual workflow flags, including transforms; execution controls, destination, visibility, and name can still be supplied. HLS custom ladders and codec-specific CRF maps are described in [hls.md](hls.md). Omitted CRFs are sent unchanged to the API.

## Plan compression and images

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --idempotency-key plan/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --codec vp9,h265 --vp9-crf 38 --h265-crf 30 --audio remove
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --codec vp9,h265 --bit-depth 10
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --codec av1 --av1-crf 42 --frame-rate preserve
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID extract-images --interval 0.5 --format webp
npx --yes densio@CLI_VERSION --org ORG_ID --json plans get PLAN_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json plans resolve PLAN_ID cap-30 --idempotency-key resolve/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json plans resolve PLAN_ID preserve --idempotency-key resolve/task-456
```

Planning freezes defaults, warnings, exact quote, expected output manifest, and resolved intent without reserving credits. The API defaults to VP9 42 and H.265 30; AV1 42 is optional and requires Basic or higher. Audio is `auto|keep|remove`: auto keeps audible audio, keep requires an audio stream, remove omits it.

Compression and quality comparison accept `--bit-depth 8|10` through both `jobs create` and `plans create`. The API defaults to 8 even for 10-bit sources. Use `--bit-depth 10` whenever the user explicitly requests 10-bit output, and retain it for final compression after a comparison. One depth applies to every selected codec and to the comparison reference reel. The API verifies 10-bit video before publication; `OUTPUT_BIT_DEPTH_MISMATCH` fails the job instead of returning an 8-bit replacement. JPEG comparison stills remain 8-bit and cannot establish 10-bit gradient quality. A bit-depth choice does not add HDR processing or restore missing source detail. HLS retains its separate Main10 SDR profile; standalone trim does not accept this flag (use compression with trim options for a 10-bit clip).

For compression with `--options-file PATH`, the equivalent options are:

```json
{ "bitDepth": 10, "codecs": ["vp9", "h265"] }
```

Capabilities advertise `options.bitDepths` and `defaults.bitDepth` for compression and comparison. New ready plans record the resolved depth; older snapshots without it retain 8-bit behavior.

An omitted compression or HLS cadence above 30 fps requires an explicit decision: direct submission returns `MEDIA_DECISION_REQUIRED`; optional plans expose their resolve action. `cap-30` uses at most 30 fps and favors clean divisors for higher source rates; `preserve` retains source cadence. Resolve creates a new immutable plan.

Extraction supports JPEG, PNG, and WebP, defaults to one frame per second, and returns a ZIP plus timestamp manifest.

Compression, extraction, and comparison support crop-before-scale transforms. HLS uses its aspect-preserving ladder instead:

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --crop-aspect 16:9 --width 1280
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --height 720 --allow-upscale
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID extract-images --crop-rect 800:600:100:50
```

Use only one scale dimension and one crop mode. Upscaling requires explicit permission through `--allow-upscale`.

## Plan a quality comparison

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compare-quality --matrix vp9:36,42,48 --matrix h265:24,30,36 --samples 3 --metric ssim,psnr
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compare-quality --matrix vp9:38,44 --matrix av1:38,44 --sample 12.5 --sample 01:02.500 --sample frame:172
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compare-quality --matrix h265:24,30 --sample 5 --sample-duration 2
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compare-quality --matrix vp9:36,42 --matrix h265:26,30 --bit-depth 10
```

Repeat `--matrix CODEC:CRF,CRF` for 2–8 unique codec/CRF candidates. Choose automatic `--samples N` or repeatable explicit `--sample`, never both. The allowed count is 1–5, default 3. Sample duration is 1–3 seconds, subject to the current capability limit and remaining source duration. Seconds, timecodes, and frame selectors are resolved by the API into exact windows before execution.

SSIM is required and defaults on; PSNR is optional. Each variant gets a preview and still from the same lossless reference reel, objective metrics, and an estimated full-video byte count. Results include the Pareto frontier, balanced SSIM/size recommendation, and confidence/coverage. Samples are video-only; estimates are extrapolations, not guarantees.

## Execute and recover

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json plans execute PLAN_ID --idempotency-key execute/task-123 --max-credits 2.50 --max-output-bytes 50000000 --client-reference release/task-123 --no-wait
npx --yes densio@CLI_VERSION --org ORG_ID --json plans execute PLAN_ID --idempotency-key execute/task-456 --output-dir ./dist/video
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs get JOB_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs wait JOB_ID --timeout 900 --output-dir ./result
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs watch JOB_ID --timeout 900
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs events JOB_ID --after 0 --limit 100
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs list --state processing --workflow compress --limit 25
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs lookup --client-reference release/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs lookup --idempotency-key execute/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs cancel JOB_ID
```

`jobs create` and optional `plans execute` create jobs. It requires a stable idempotency key, reserves the exact quote, attaches verified input, and queues work. Retry identical execute intent with the same key; a new key intentionally creates a new charged execution. Keys are non-empty and at most 200 characters.

`--max-credits` allows at most two decimal places. Planning and execution can both constrain credits and aggregate output bytes. The byte ceiling is checked after encoding; an oversize encode is charged and publishes no artifacts.

Execution waits by default. `--no-wait` returns a resumable ID and excludes `--output-dir`. Timeout/interruption ends only the local wait. Events have an exclusive sequence cursor; wait/watch emit deduplicated JSONL on stderr and one final success document on stdout. Terminal failures produce problems rather than a success document.

Plans retain their immutable state after their deadline. Check `availability` and advertised actions: expired or source-unavailable plans cannot start new work. Exact execution replays still recover their existing job; an expired plan requires a fresh plan/key only for intentionally new work.

## Artifacts and local outputs

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json artifacts get ARTIFACT_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json artifacts authorize ARTIFACT_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json artifacts download ARTIFACT_ID --output ./video.webm
npx --yes densio@CLI_VERSION --org ORG_ID --json artifacts materialize JOB_ID --output-dir ./result
npx --yes densio@CLI_VERSION --org ORG_ID --json artifacts materialize JOB_ID --output-dir ./result --force
npx --yes densio@CLI_VERSION --org ORG_ID --json artifacts delete ARTIFACT_ID
```

The required terminal receipt preserves execution facts. The result contains artifact IDs and workflow-specific metrics/HTML. The separate live artifact inventory is authoritative for availability. Deleted/expired descriptors remain readable, but cannot receive new grants.

Authorization is independent of retention. The CLI authorizes just in time and checks byte count plus SHA-256 before publishing locally. Materialization includes available outputs, a manifest, and relative HTML for compression. It does not store temporary bearer URLs. Preserve manifest filenames; `--force` is only for intentional replacement and offers best-effort rollback across files.

Automatic cleanup expires abandoned uploads, recovers interrupted preparation, removes terminal scratch work, expires grants, and deletes retained bytes at their deadlines. Explicit source/artifact deletion is idempotent; incomplete physical deletion remains retryable. Neither downloading nor materializing silently deletes remote data.

## Trim videos

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID trim --codec h265 --trim-start frame:300 --trim-end frame:750 --idempotency-key trim/task-123
npx --yes densio@CLI_VERSION --org ORG_ID --json jobs create SOURCE_ID compress --trim-start frame:300 --trim-end frame:750 --idempotency-key compress/clip-123
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID trim --codec vp9 --trim-start 00:00:10.125
```

`--trim-start` is required for standalone trim. Positions accept `frame:N`, decimal
seconds, or timecode. Frames are zero-based source frames in presentation order;
start is inclusive and end exclusive. Omit `--trim-end` to keep the rest of the video.
Time positions snap forward to frame boundaries. Read the resolved range in the
execution snapshot when actual boundaries matter; never calculate frame times from
average FPS for a variable-frame-rate source.

Standalone `trim` requires exactly one `--codec` and uses its shared CRF default;
only that codec's CRF flag is valid. Cadence is preserved; odd dimensions use the
existing even-dimension encoder normalization. Trimming
re-encodes and does not promise lossless pixels or preservation of the source codec.
Audio is retained when present; explicit `--audio keep` requires an audio stream,
and `--audio remove` omits it. Compression applies its ordinary transforms and
cadence choice after selecting the range. Automatic audio detection considers the clip.

Both paths use the selected duration for the exact quote. Source upload/duration
limits still apply to the whole source. Reuse the accepted retry key after uncertainty;
changing the range requires a new key. Storage, waiting, events, and verified artifact
materialization use the usual job commands. Trimming is not available on HLS,
image extraction, or quality comparison.

Waiting uses one deadline for polling, HTTP response bodies, token refresh, and retry sleeps. A timeout leaves the server job running. `jobs watch` and `jobs wait` drain persisted event pages before returning a terminal status; job status determines the terminal result. Resume with the same job ID after a timeout.

Invalid local storage/video arguments and unreadable workflow options files fail before authentication. Schema errors identify the invalid option paths; inspect command help for accepted values.
