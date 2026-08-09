export const CLI_HELP = `densio — agent-first video processing

Usage:
  densio [--api-url URL] [--json] <command>

Commands:
  auth login|status|logout       Authenticate with a magic email link
  capabilities                  Inspect codecs, limits, and server defaults
  compress <video>              Create optimized web video outputs
  extract-images <video>        Extract interval images into a ZIP archive
  compare-quality <video>       Compare codec CRFs at a source position
  jobs get|wait|cancel           Inspect, resume, or cancel asynchronous jobs
  artifacts download            Download and SHA-256 verify an artifact
  billing subscribe PLAN|portal Open Stripe Checkout or Customer Portal

Agent behavior:
  --json emits one success document on stdout; problems use stderr.
  Media commands wait by default. Use --no-wait for a resumable job ID.

Global options:
  --api-url URL                 API base URL (or DENSIO_API_URL)
  --credentials PATH           Override the owner-only credential file
  --json                       Stable schema-versioned machine output

Compression options:
  --codec vp9,h265,av1         Select outputs (default: vp9,h265)
  --vp9-crf N                  VP9 CRF 0-63
  --h265-crf N                 H.265 CRF 0-51
  --av1-crf N                  AV1 CRF 0-63
  --audio auto|keep|remove     Audio policy (default: auto)

Extraction options:
  --interval SECONDS           Positive fractional interval (default: 1)
  --format jpeg|png|webp       Archive image format (default: jpeg)

Comparison options:
  --codec vp9|h265|av1         Preview codec (default: vp9)
  --crf N,N                    Two to eight unique CRFs
  --duration SECONDS           Sample duration from 1 to 3 (default: 1)
  --at SECONDS|TIMECODE        Sample start, such as 62.5 or 01:02.500
  --frame N                    Exact zero-based source frame instead of --at

Shared media options:
  --width N | --height N       Proportional output scale
  --allow-upscale              Explicitly permit scaling above source size
  --crop-aspect W:H            Center crop to an aspect ratio
  --crop-rect W:H:X:Y          Explicit crop rectangle
  --idempotency-key KEY        Safe creation retry key
  --timeout SECONDS            Stop waiting without canceling the server job
  --no-wait                    Return job ID and resume command after upload

Artifact download:
  artifacts download SIGNED_URL --output PATH --sha256 HEX
  --force                      Explicitly replace an existing output path

Examples:
  densio capabilities --json
  densio compress input.mp4 --json
  densio compare-quality input.mp4 --crf 28,34,40 --at 01:12.500 --json
  densio jobs wait JOB_ID --json
`;
