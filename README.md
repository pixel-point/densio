# Densio

Large video files slow websites down. Densio turns source video into smaller, web-ready outputs at the quality level you choose, so each visitor downloads less data.

Densio is an agent-first video compression service. Tell your coding agent what the site needs. Densio handles media inspection, codec policy, long-running FFmpeg jobs, and verified downloads through a small CLI.

## Use Densio from your agent

Install the Densio skill:

```sh
npx skills add pixel-point/densio --skill densio
```

Then give your agent a concrete prompt:

```text
Use $densio to compress ./public/hero.mov for the web. Keep the original resolution, keep audio only when it is audible, and download the optimized files next to the source.
```

The installed skill fetches the current Densio workflow instructions when used. It tells the agent to inspect server capabilities, authenticate through a magic email link when needed, submit the job, and verify downloaded artifacts.

## Current features

- Compress to VP9/WebM and H.265/MP4 by default, or request AV1/WebM explicitly.
- Preserve source resolution or crop and resize by width or height. Upscaling requires an explicit request.
- Detect audible audio automatically, keep it, or remove audio entirely.
- Extract JPEG, PNG, or WebP frames at a chosen interval into a ZIP with a timestamp manifest.
- Compare two to eight CRF values at a second, timecode, or exact source frame, with preview files and coarse full-video size estimates.
- Keep compression, extraction, and comparison jobs running when the agent disconnects. Jobs can be inspected, resumed, or cancelled.
- Return signed downloads, SHA-256 hashes, the executed FFmpeg commands, and a ready-to-use HTML `<video>` snippet for compressed output.
- Delete source uploads and intermediate files after terminal processing. Published artifacts expire after 24 hours by default.

## Why use Densio instead of local FFmpeg?

FFmpeg is the encoder inside Densio. Densio adds a fixed web-video policy and a durable service around it.

With local FFmpeg, you choose every codec, preset, CRF, filter, audio rule, container flag, and output path. You also own the process lifetime, retries, cleanup, and result validation. That control is useful for one-off work or unusual formats.

Densio gives agents three typed workflows: compression, frame extraction, and quality comparison. The server inspects the source, applies the same policy on every machine, keeps long jobs alive, and returns structured results. Agents do not have to invent shell commands or parse an FFmpeg log to find the output.

Use local FFmpeg when you need exact control over every argument or a quick local preview. Use Densio for repeatable web outputs, agent-driven work, durable remote jobs, and consistent compression across projects.

## Slow on purpose

Densio deliberately chooses slow encodes. VP9 runs with `deadline=best`, H.265 uses `preset=veryslow`, and AV1 uses SVT-AV1 preset 6. These settings favor compression efficiency over turnaround time.

Expect long jobs, especially for large sources and multiple codecs. Densio accepts that cost to pursue the smallest practical output at the selected quality. The durable queue lets the agent disconnect and resume later instead of keeping one local terminal alive for the entire encode.

## Plans

Every plan supports VP9, H.265, and AV1, with a 30-minute input limit.

| Plan  | Monthly credits | Maximum upload | Queue priority |
| ----- | --------------: | -------------: | -------------- |
| Free  |              30 |           1 GB | Standard       |
| Basic |             750 |          10 GB | Paid           |
| Pro   |           5,000 |          10 GB | Paid           |
| Scale |           7,500 |          10 GB | Paid           |

The Free plan includes 30 credits each UTC month and access to every codec. A five-minute 1080p source costs 1 credit per output codec, so the default VP9 and H.265 pair costs 2 credits. At that size, the Free plan covers fifteen default two-codec compressions each month. Image extraction and quality comparison currently cost 0.05 credits each.

Basic, Pro, and Scale are for higher-volume optimization, larger uploads, frequent quality experiments, and paid queue priority. You can also self-host Densio and run the same workflows on your own hardware.

## Direct CLI use

The skill is the main interface for agents, but the CLI also works directly:

```sh
npx densio --help
npx densio capabilities --json
npx densio compress ./public/hero.mov --json
npx densio extract-images ./public/hero.mov --interval 1 --format webp --json
npx densio compare-quality ./public/hero.mov --codec vp9 --crf 34,38,42 --at 00:05.000 --json
```

The CLI defaults to `https://api.densio.sh`. Pass `--api-url` explicitly when using a local or self-hosted API. Media commands wait by default; `--no-wait` returns a job ID and resume command.

## Self-hosting

Densio is licensed under AGPL-3.0-only and can run on one VPS. The service uses a Node API, SQLite, an internal worker pool, and a host-mounted FFmpeg/FFprobe bundle. It does not require Redis, a separate queue service, or object storage.

A production host needs:

- FFmpeg and FFprobe with `libvpx-vp9`, `libx265`, and `libsvtav1` encoders;
- persistent storage for SQLite, uploads, workspaces, and temporary artifacts;
- HTTPS through a reverse proxy;
- Resend credentials for magic-link authentication;
- Stripe configuration when offering paid plans.

The container expects the pinned FFmpeg bundle at `/opt/ffmpeg` and persistent application data at `./data`. Start with [.env.example](.env.example), [docker-compose.yml](docker-compose.yml), and the [Dockerfile](Dockerfile). Keep the application port behind the HTTPS proxy and back up SQLite with a SQLite-aware online backup or while the service is stopped.

## Local development

Requirements: Node 22.18 or newer, pnpm 11.7, FFmpeg, and FFprobe.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
set -a
. ./.env
set +a
pnpm dev
```

Run the CLI against the local API from another terminal:

```sh
pnpm --filter densio start -- --api-url http://localhost:3000 --help
```

Repository checks:

```sh
pnpm lint
pnpm format
pnpm test
pnpm typecheck
pnpm build
```

## License

[AGPL-3.0-only](LICENSE)
