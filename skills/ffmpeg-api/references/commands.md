# Command reference

Always add `--json` for agent use.

## Inspect and authenticate

```sh
ffmpeg-api --json capabilities
ffmpeg-api --json auth status
ffmpeg-api --json auth login agent@example.com
ffmpeg-api --json auth logout
```

The API URL precedence is `--api-url`, `FFMPEG_API_URL`, config, then `http://localhost:3000`. Credentials are owner-only and bound to the normalized API origin.

## Compress

Article-inspired VP9/WebM and H.265/MP4 defaults:

```sh
ffmpeg-api --json compress input.mp4
```

Choose codecs or CRFs:

```sh
ffmpeg-api --json compress input.mp4 --codec vp9,h265 --vp9-crf 38 --h265-crf 30
ffmpeg-api --json compress input.mp4 --codec av1 --av1-crf 35
```

Audio policy is `--audio auto|keep|remove`. `auto` keeps only detected audible audio. `keep` fails if no audio track exists; `remove` always omits it.

## Extract frames

```sh
ffmpeg-api --json extract-images input.mp4
ffmpeg-api --json extract-images input.mp4 --interval 0.5 --format webp
```

Formats are `jpeg`, `png`, and `webp`. The result is a ZIP with a timestamp manifest.

## Compare quality

```sh
ffmpeg-api --json compare-quality input.mp4 --codec vp9 --crf 30,36,42
ffmpeg-api --json compare-quality input.mp4 --crf 28,34,40 --at 01:12.500
ffmpeg-api --json compare-quality input.mp4 --crf 28,34 --frame 172 --duration 3
```

Use either `--at` or `--frame`, never both. `--at` is the sample start and accepts non-negative seconds or `HH:MM:SS.mmm` / `MM:SS.mmm`. Duration is 1–3 seconds. Comparison previews intentionally omit audio.

## Transform output

All workflows preserve source resolution by default. Cropping occurs before scaling.

```sh
ffmpeg-api --json compress input.mp4 --width 1280
ffmpeg-api --json compress input.mp4 --height 720 --allow-upscale
ffmpeg-api --json compress input.mp4 --crop-aspect 16:9 --width 1280
ffmpeg-api --json extract-images input.mp4 --crop-rect 800:600:100:50
```

Use only one of `--width` or `--height`, and only one crop mode. If the requested dimension exceeds the cropped source, the job fails unless `--allow-upscale` is explicit.

Transform, `--no-wait`, `--timeout`, and `--idempotency-key` flags apply to all three media commands. Audio and codec-specific CRFs apply only to compression. Comparison uses `--codec`, `--crf`, `--duration`, `--at`, and `--frame`. Extraction uses `--interval` and `--format`.

## Wait, resume, and cancel

```sh
ffmpeg-api --json compress input.mp4 --no-wait --idempotency-key task-123
ffmpeg-api --json jobs get JOB_ID
ffmpeg-api --json jobs wait JOB_ID --timeout 900
ffmpeg-api --json jobs cancel JOB_ID
```

`--timeout` stops the client wait; it does not cancel server processing.

Idempotency keys are non-empty and at most 200 characters. Reuse a key only for byte-for-byte equivalent creation intent.

## Billing and downloads

```sh
ffmpeg-api --json billing subscribe
ffmpeg-api --json billing portal
ffmpeg-api --json artifacts download 'SIGNED_URL' --output ./video.webm --sha256 HEX
# Add --force only when replacing an existing destination is intentional.
```

Present the returned Stripe URL to the user; do not claim billing changed until a later capabilities or billing response confirms Pro.

Before the final encode after comparison, ask whether the user wants only the compared codec or the default VP9 + H.265 compatibility pair. Do not infer that choice from “web optimized.”
