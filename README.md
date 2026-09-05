# Densio - Agent-first video compression for the web

- Improve your site's performance by properly compressing videos while preserving quality.
- Stop using GIFs. They are larger and look worse than properly compressed video files.
- Reduce file sizes by up to 10x.

HLS VOD is available through `jobs create SOURCE_ID hls`: HEVC Main10, shared AAC, source-aware renditions, and a single ZIP or durable package. Omitted H.265 CRF matches compression (currently 30). Direct submission is the normal path for all media workflows; execution plans remain optional previews. See [CLI usage](apps/cli/README.md) and the generated `/docs` API reference.

HLS encoding uses a separate `HLS_MAX_SCRATCH_BYTES` operational guard (20 GiB by default) for the combined package and ZIP, plus a 64 MiB media-filesystem reserve. It samples during encoding/archiving and cancels oversized work; managed storage counts package members once. See the [HLS benchmark and verification report](apps/api/benchmarks/hls/README.md) for profile trade-offs and playback validation limits.

## Use Densio from your agent

Install the Densio skill in your coding agent, then ask it to process a video:

```sh
npx skills add pixel-point/densio --skill densio
```

Requires an agent that can run terminal commands, Node.js 22.18 or later, npm/npx, and internet access. On first use, your agent asks for your email and waits while you confirm the emailed sign-in link. Your first workspace and Free allowance are created automatically. The agent handles uploading, processing, and saving the results; no global CLI installation or API key setup is needed.

**Basic prompt:**

```text
Use Densio to compress ./public/hero.mov
```

**Advanced prompt:**

```text
Use Densio to compress ./public/hero.mov. Resize the output to 1280 pixels wide while preserving its aspect ratio. Create VP9 at CRF 40 and H.265 at CRF 28.
```

**Compare quality**

If you care about the size-to-quality ratio, ask Densio to compare quality. It will compress a few short samples at different quality levels and estimate the full output file sizes, so you can decide which result works for you.

```text
Use Densio and compare quality of ./public/hero.mov
```

**Extract images**

Give your agent a clearer view of a video sequence or animation by asking Densio to extract images from it.

```text
Use Densio and extract images from ./public/hero.mov
```

## Features

- Compress to VP9/WebM and H.265/MP4 by default. Basic and higher plans can request AV1/WebM explicitly.
- Preserve source resolution or crop and resize by width or height.
- Detect sources above 30 fps and ask whether to preserve their cadence or cap it for typical web delivery.
- Detect audible audio automatically, keep it, or remove audio entirely.
- Extract JPEG, PNG, or WebP frames at a chosen interval.
- Compare two to eight VP9, H.265, and AV1 candidates over representative samples in one job. Densio reports SSIM, optional PSNR, size extrapolations, the Pareto frontier, and a balanced recommendation.
- Upload once into a reusable prepared source, inspect trusted media facts, and obtain an immutable exact-credit execution plan before encoding.
- Recover jobs by idempotency key or client reference, consume ordered progress events, and materialize retained artifacts with byte-count and SHA-256 verification.

## Video trimming

Use `jobs create SOURCE_ID trim --codec h265 --trim-start frame:300 --trim-end frame:750 --idempotency-key clip-1` for one clip, or add the same trim flags to compression. Frames are zero-based source positions; start is included and end excluded. Seconds and timecodes are also accepted, and omitted end means video EOF. Trimming re-encodes; standalone clips preserve cadence and apply the existing even-dimension encoder normalization. Quotes use the selected duration while source limits apply to the upload.

## Privacy

Uploaded sources and generated artifacts have independent retention deadlines, exposed by the API. Delete either explicitly when no longer needed; automatic cleanup removes their media bytes at expiry. Job receipts and source/artifact tombstones retain execution and deletion history, not the deleted video bytes.

## Why use Densio instead of local FFmpeg?

Agents do not always work on your most powerful computer. Many people run them on a small VPS, a Mac Mini, or an AI cloud sandbox—environments that are not well suited to CPU-intensive work like video compression.

Densio maintains an up-to-date set of codecs and compression practices battle-tested on real projects. It aims for the best possible compression while staying simple enough for non-technical users.

## Highest possible compression

Densio chooses the most CPU-intensive compression settings. Encoding takes longer, but produces the smallest practical files while preserving quality.

## Plans

Plans and monthly usage belong to organizations, not users. All members share one allowance;
adding people never adds seats or multiplies credits. Each organization has its own billing
contact, Stripe customer/subscription, media, and ledger.

Every plan supports VP9 and H.265. AV1 requires Basic or higher. Free inputs are limited to 30 minutes; Basic, Pro, and Scale inputs can be up to 180 minutes.

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

The Free plan includes 30 credits each UTC month and access to both default codecs, VP9 and H.265. That is enough for up to 300 15-second 1080p videos or 15 five-minute 1080p videos when producing both default outputs. Frame extraction costs 0.05 credits per job. Quality comparison is metered by sampled duration, resolution, and candidate count, with a 0.05-credit minimum. Every execution plan provides its exact quote.

These estimates assume that the output stays at 1920x1080.

## Direct CLI use

First confirmed signup automatically creates an ordinary “My organization”. List memberships
with `npx densio --json orgs list`, then pin `--org ORG_ID` for the whole workflow.
Selection precedence is `--org` → `DENSIO_ORG_ID` → saved local context → server default;
invalid selections fail instead of falling back. `orgs use ORG_ID` changes local context only;
`orgs default ORG_ID` changes the server default only. Creating/joining an org changes neither.

All members can process, spend shared credits, and manage media. Owners/admins manage ordinary
members and invitations; only owners manage admins, billing, ownership transfer, and closure.
Use `orgs invitations create EMAIL --role member` and recipient `invitations accept ID`.
Invite acceptance requires the verified recipient email. Removing a member revokes their
download grants, but admitted jobs and media remain with the organization.

`billing subscribe PLAN --idempotency-key KEY` creates or recovers an organization checkout.
Preserve the key after uncertain responses; use `billing portal` for existing subscriptions.
`billing contact EMAIL` changes billing email independently of login identity.
`orgs delete ORG_ID --confirm ORG_ID` requires ownership and no active work or unresolved billing.
It returns `deleting` until durable byte cleanup finishes; poll `orgs get ORG_ID`.
The API never automatically cancels subscriptions or refunds work during closure.

Scalar is at `/docs`, with generated contracts at `/openapi.json`. Media and billing control
routes are under `/v1/organizations/{organizationId}`; unscoped aliases do not exist.

The CLI uses the same upload → submit → download flow as the agent skill. Plans are optional previews:

```sh
npx densio --help
npx densio --org ORG_ID --json capabilities
npx densio --org ORG_ID --json inspect ./public/hero.mov --idempotency-key source/hero
npx densio --org ORG_ID --json sources list --state ready
npx densio --org ORG_ID --json plans create SOURCE_ID compare-quality --matrix vp9:36,42 --matrix h265:26,30 --samples 3 --metric ssim,psnr
npx densio --org ORG_ID --json plans create SOURCE_ID compress --codec vp9,h265 --frame-rate cap-30
npx densio --org ORG_ID --json plans create SOURCE_ID extract-images --interval 1 --format webp
npx densio --org ORG_ID --json plans execute PLAN_ID --idempotency-key execute/hero --max-credits 2.00 --output-dir ./public/video
```

The CLI defaults to `https://api.densio.sh`. Pass `--api-url` explicitly for local or self-hosted APIs. Upload once and reuse the source ID for each plan. Compression encodes the full video unless a trim range is supplied. Standalone trimming creates one frame-accurate re-encoded clip. A comparison accepts 2–8 unique codec/CRF candidates and 1–5 shared samples (default 3). A single sample is valid but carries low coverage confidence.

Plans snapshot trusted inspection, requested and fully resolved options, exact credits, expected artifacts, warnings, observed tool versions, deadlines, and an intent digest. Planning starts no encode and reserves no credits. If a high-frame-rate compression plan requires a decision, use `plans resolve PLAN_ID cap-30|preserve` to create an immutable child plan before executing it.

`plans execute` requires an idempotency key and waits by default. `--no-wait` returns a resumable job ID. `--max-credits` is a pre-spend guard. `--max-output-bytes` rejects the complete staged output bundle before publication when it is too large; completed encoding still consumes the quoted credits. Ordinary failure or cancellation releases the reservation.

```sh
npx densio --org ORG_ID --json jobs lookup --client-reference site/hero
npx densio --org ORG_ID --json jobs watch JOB_ID --timeout 300
npx densio --org ORG_ID --json artifacts materialize JOB_ID --output-dir ./public/video
npx densio --org ORG_ID --json artifacts download ARTIFACT_ID --output ./public/hero.webm
npx densio --org ORG_ID --json sources delete SOURCE_ID
npx densio --org ORG_ID --json artifacts delete ARTIFACT_ID
```

Jobs expose ordered events, structured progress, organization-scoped history, live artifact availability, and a required terminal execution receipt. The receipt is immutable evidence; deleting or expiring output bytes does not turn a successful job into an expired job. Exact execution retries with the same key recover the same job, including after plan expiry.

Artifact IDs identify outputs independently of short-lived download grants. Materialization obtains fresh grants, verifies byte counts and SHA-256, and writes relative HTML and a local manifest without bearer URLs. Existing files are protected unless `--force` is explicit. Downloading does not delete remote resources. Source deletion blocks new input attachment but does not remove input already attached to a job, generated artifacts, or receipts. Automatic cleanup remains active for interrupted uploads/preparation, terminal workspaces, expired grants, retained bytes, and incomplete deletions.

## Self-hosting

Densio is licensed under AGPL-3.0-only and can run on one VPS. The service uses a Node API, SQLite, an internal worker pool, and a host-mounted FFmpeg/FFprobe bundle. It does not require Redis, a separate queue service, or object storage.

Run one API container per database/media directory; do not share those mounts across containers
with separate PID namespaces. Upload/job-writer recovery checks OS process-start identity before
reclaiming abandoned writes, including after PID reuse or a container restart. Job child processes
are tracked independently, and cancellation waits for process exit. Resource cleanup uses durable
pending markers and bounded pages; it waits for writers and does not repeatedly delete cleaned history.

Platform operators can inspect and recover interrupted billing operations locally:

```sh
pnpm --filter @densio/api admin billing inspect ORG_ID
pnpm --filter @densio/api admin billing reconcile ORG_ID
```

In the image, use `node /app/dist/admin.js billing inspect ORG_ID` (or `reconcile`).
Inspection never returns hosted bearer URLs. Reconciliation reuses persisted contact intent or
reads existing checkout/customer/subscription evidence; it never creates replacement payments.
Missing financial evidence remains blocked for provider investigation. Contact retries remain
safe after the provider's idempotency window; failed portal minting releases its temporary lock.
These commands require platform-operator authority and configured Stripe access for reconciliation.

A production host needs:

- FFmpeg and FFprobe with `libvpx-vp9`, `libx265`, and `libsvtav1` encoders;
- persistent storage for SQLite, uploads, workspaces, and temporary artifacts;
- HTTPS through a reverse proxy;
- Resend credentials for magic-link authentication;
- Stripe configuration when offering paid plans.

The container expects the pinned FFmpeg bundle at `/opt/ffmpeg` and persistent application data at `./data`. Start with [.env.example](.env.example), [docker-compose.yml](docker-compose.yml), and the [Dockerfile](Dockerfile). Keep the application port behind the HTTPS proxy and back up SQLite with a SQLite-aware online backup or while the service is stopped.

## Video storage

Compression artifacts stay temporary unless a plan selects storage or `videos save` is used. Paid plans can publish to Densio-managed Cloudflare R2; every plan can connect S3-compatible output and private staging. Stored videos are public by default and return stable embed URLs such as `orgs/ORG_ID/videos/VIDEO_ID/homepage-hero-vp9.webm`. Private variants use short-lived, membership-bound range downloads.

Managed capacity is 0 GB on Free, 25 GB on Basic, 100 GB on Pro, and 500 GB on Scale (decimal bytes). Downgrades preserve embeds for a fixed 30-day grace period before whole video groups are deleted newest-first to meet the new allowance. The API records multipart progress, verifies full bytes and SHA-256 before publishing, retains a 24-hour recovery window without re-encoding, and audits ready objects daily.

Customer credentials are encrypted with versioned AES-256-GCM keys outside SQLite. Connection validation checks create/upload/complete/read/range/abort/delete and public/private behavior. See [infra/r2/README.md](infra/r2/README.md) for reproducible R2 buckets, domain, lifecycle rules, runtime secret shape, backups, and launch certification. No infrastructure is applied by this repository change.

## Local development

Requirements: Node 22.18 or newer, pnpm 11.7, FFmpeg, and FFprobe.

This pre-production architecture intentionally does not decode old media-job records. For an
existing development setup, stop the old service and use a new, explicitly named data directory
with both a new `DATABASE_PATH` and `MEDIA_ROOT`. Keep the previous SQLite database (including
its WAL files) and media directory as a backup; do not run a reset against shared or valuable data.
Fresh databases use the canonical generated migrations; no legacy media backfill is provided.

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

`pnpm test` includes the deterministic golden E2E journey. It starts the real HTTP application,
runs the built CLI through magic-link authentication and a signed Basic-plan upgrade, reuses one
committed upload for mixed-codec comparison, extraction, and real AV1 encoding, materializes the
verified artifact, and inspects it with
FFprobe. Explicit `pnpm synthetic:staging` and `pnpm synthetic:production` commands extend that
journey to deployed providers without adding test-only production behavior. See
[e2e/README.md](e2e/README.md) for setup and guarantees.

## License

[AGPL-3.0-only](LICENSE)

## Developing

Use Node **22.18.0** (`.node-version`) and Corepack-managed pnpm **11.7.0**:

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm test:fast
pnpm typecheck
```

`pnpm test:fast` runs deterministic contracts, services, CLI and workspace checks without FFmpeg. `pnpm test:media` runs native media tests and the local golden journey; install FFmpeg/FFprobe with `libsvtav1`, `libvpx-vp9` and `libx265`. `pnpm test` includes both. Before handoff run `pnpm format`, `pnpm check` and, for build inputs or entrypoints, `pnpm build`. API scripts and Drizzle configuration are included in typechecking. CI verifies the baseline, media journey, CLI packaging and Docker build.

For local CLI work, use an explicit `--api-url http://127.0.0.1:3000` and a disposable `--credentials` path. Tests use local databases, HTTP servers and provider boundaries; deployed synthetic journeys are separate opt-in commands. See [the domain and ownership map](CONTEXT.md) for architecture, lifecycle health and operator storage recovery.
