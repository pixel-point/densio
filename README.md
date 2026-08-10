# Densio - Agent-first video compression for the web

- Improve your site's performance by properly compressing videos while preserving quality.
- Stop using GIFs. They are larger and look worse than properly compressed video files.
- Reduce file sizes by up to 10x.

## Use Densio from your agent

Install the Densio skill:

```sh
npx skills add pixel-point/densio --skill densio
```

**Basic prompt:**

```text
Use /densio to compress ./public/hero.mov
```

**Advanced prompt:**

```text
Use /densio to compress ./public/hero.mov. Resize the output to 1280 pixels wide while preserving its aspect ratio. Create VP9 at CRF 40 and H.265 at CRF 28.
```

**Compare quality**

If you care about the size-to-quality ratio, ask Densio to compare quality. It will compress a few short samples at different quality levels and estimate the full output file sizes, so you can decide which result works for you.

```text
Use /densio and compare quality of ./public/hero.mov
```

**Extract images**

Give your agent a clearer view of a video sequence or animation by asking Densio to extract images from it.

```text
Use /densio and extract images from ./public/hero.mov
```

## Features

- Compress to VP9/WebM and H.265/MP4 by default, or request AV1/WebM explicitly.
- Preserve source resolution or crop and resize by width or height.
- Detect audible audio automatically, keep it, or remove audio entirely.
- Extract JPEG, PNG, or WebP frames at a chosen interval.
- Compare quality by compressing short sections at different quality levels and estimating full file sizes, so you can choose the size-to-quality ratio yourself.

## Privacy

Densio only keeps your files long enough to process and download them. After compression, files remain available for up to 24 hours, then they are deleted.

## Why use Densio instead of local FFmpeg?

Agents do not always work on your most powerful computer. Many people run them on a small VPS, a Mac Mini, or an AI cloud sandbox—environments that are not well suited to CPU-intensive work like video compression.

Densio maintains an up-to-date set of codecs and compression practices battle-tested on real projects. It aims for the best possible compression while staying simple enough for non-technical users.

## Highest possible compression

Densio chooses the most CPU-intensive compression settings. Encoding takes longer, but produces the smallest practical files while preserving quality.

## Plans

Every plan supports VP9, H.265, and AV1, with a 30-minute input limit.

| Plan  | Monthly credits | Maximum upload | Queue priority |
| ----- | --------------: | -------------: | -------------- |
| Free  |              30 |           1 GB | Standard       |
| Basic |             750 |          10 GB | Paid           |
| Pro   |           5,000 |          10 GB | Paid           |
| Scale |           7,500 |          10 GB | Paid           |

Compression credits are based on video duration, source and output resolution, and the number of output codecs. Each job has a minimum cost of 0.05 credits and is rounded up to the nearest 0.05. VP9, H.265, and AV1 cost the same; each requested codec counts as one output.

For a 1920x1080 video kept at its original resolution:

| Video length | One codec | VP9 + H.265 |
| ------------ | --------: | ----------: |
| 15 seconds   |      0.05 |        0.10 |
| 1 minute     |      0.20 |        0.40 |
| 5 minutes    |      1.00 |        2.00 |

The Free plan includes 30 credits each UTC month and access to every codec. That is enough for up to 300 15-second 1080p videos or 15 five-minute 1080p videos when producing the default VP9 and H.265 outputs. Frame extraction and quality comparison cost 0.05 credits per job.

These estimates assume that the output stays at 1920x1080.

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
