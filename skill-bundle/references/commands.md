# Command reference

Always add `--json` for agent use.

## Inspect and authenticate

```sh
npx densio --json capabilities
npx densio --json auth status
npx densio --json auth login agent@example.com
npx densio --json auth logout
```

The API URL precedence is `--api-url`, `DENSIO_API_URL`, config, then `https://api.densio.sh`. Pass `--api-url` explicitly for local or self-hosted testing. Credentials are owner-only and bound to the normalized API origin.

## Compress

Article-inspired VP9/WebM and H.265/MP4 defaults:

```sh
npx densio --json compress input.mp4
```

Omitting CRF flags uses VP9 42, H.265 30, and AV1 42.

Choose codecs or CRFs:

```sh
npx densio --json compress input.mp4 --codec vp9,h265 --vp9-crf 38 --h265-crf 30
npx densio --json compress input.mp4 --codec av1 --av1-crf 42
```

Audio policy is `--audio auto|keep|remove`. `auto` keeps only detected audible audio. `keep` fails if no audio track exists; `remove` always omits it.

## Extract frames

```sh
npx densio --json extract-images input.mp4
npx densio --json extract-images input.mp4 --interval 0.5 --format webp
```

Formats are `jpeg`, `png`, and `webp`. The result is a ZIP with a timestamp manifest.

## Compare quality

Unless the user requests different or fewer codecs, run separate H.265 and VP9 comparisons because each invocation accepts one codec. Select seven CRFs for each codec from the current `capabilities` response: the advertised default, three values below it, and three above it, all separated by 2. For example, when the advertised defaults are H.265 30 and VP9 42:

```sh
npx densio --json compare-quality input.mp4 --codec h265 --crf 24,26,28,30,32,34,36
npx densio --json compare-quality input.mp4 --codec vp9 --crf 36,38,40,42,44,46,48
npx densio --json compare-quality input.mp4 --crf 28,34,40 --at 01:12.500
npx densio --json compare-quality input.mp4 --crf 28,34 --frame 172 --duration 3
```

Use either `--at` or `--frame`, never both. `--at` is the sample start and accepts non-negative seconds or `HH:MM:SS.mmm` / `MM:SS.mmm`. Duration is 1–3 seconds. Comparison previews intentionally omit audio.

## Transform output

All workflows preserve source resolution by default. Cropping occurs before scaling.

```sh
npx densio --json compress input.mp4 --width 1280
npx densio --json compress input.mp4 --height 720 --allow-upscale
npx densio --json compress input.mp4 --crop-aspect 16:9 --width 1280
npx densio --json extract-images input.mp4 --crop-rect 800:600:100:50
```

Use only one of `--width` or `--height`, and only one crop mode. If the requested dimension exceeds the cropped source, the job fails unless `--allow-upscale` is explicit.

Transform, `--no-wait`, `--timeout`, and `--idempotency-key` flags apply to all three media commands. Audio and codec-specific CRFs apply only to compression. Comparison uses `--codec`, `--crf`, `--duration`, `--at`, and `--frame`. Extraction uses `--interval` and `--format`.

## Wait, resume, and cancel

```sh
npx densio --json compress input.mp4 --no-wait --idempotency-key task-123
npx densio --json jobs get JOB_ID
npx densio --json jobs wait JOB_ID --timeout 900
npx densio --json jobs cancel JOB_ID
```

`--timeout` stops the client wait; it does not cancel server processing.

Idempotency keys are non-empty and at most 200 characters. Reuse a key only for byte-for-byte equivalent creation intent.

## Billing and downloads

```sh
npx densio --json billing subscribe basic
npx densio --json billing subscribe pro
npx densio --json billing subscribe scale
npx densio --json billing portal
npx densio --json artifacts download 'SIGNED_URL' --output ./video.webm --sha256 HEX
# Add --force only when replacing an existing destination is intentional.
```

Use the paid plan the user requested. Present the returned Stripe URL; do not claim billing changed until a later capabilities or billing response confirms the selected plan. Media jobs initially reserve 0.05 credits. Compression automatically adjusts that reservation after inspection based on duration, average input/output resolution, and output codec count, rounded up to 0.05 credits; a five-minute 1080p source costs 1 credit per output codec. No quote or confirmation step interrupts processing.

Before the final encode after comparison, ask whether the user wants only the compared codec or the default VP9 + H.265 compatibility pair. Do not infer that choice from “web optimized.”
