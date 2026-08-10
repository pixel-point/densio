# Densio

An agent-first, self-hosted video-processing API and CLI. It turns a few typed
workflows into durable FFmpeg jobs without exposing arbitrary command arguments:

- web compression to VP9/WebM and H.265/MP4 by default;
- explicit AV1/WebM compression;
- interval image extraction to a ZIP with a manifest;
- CRF quality comparisons at a time, timecode, or exact source frame.

The API keeps SQLite, uploads, and expiring outputs on one VPS. It needs no
Redis, queue service, or object store. The application image contains Node 22
only; a pinned static FFmpeg/FFprobe bundle is mounted read-only from the host.

## Architecture

`apps/api` is a Hono HTTP service with Effect workflows, a durable SQLite queue,
an internal worker pool, passwordless email authentication, Resend delivery, and
Stripe subscription billing. `apps/cli` owns authentication, streaming uploads,
job polling, resumability, verified downloads, and stable agent-facing JSON.
`packages/shared` owns the schemas shared by both.

The default global ceiling is three running media child processes. Job leases,
heartbeats, and conditional transitions make interrupted work recoverable after
a restart. FFmpeg receives an executable plus an argument array directly; no
request is evaluated by a shell.

Plans use automatic monthly credits. Every plan supports VP9, H.265, and AV1,
with the same 30-minute input-duration safety ceiling:

| Plan  | Monthly credits | Maximum upload | Queue priority |
| ----- | --------------: | -------------: | -------------- |
| Free  |              30 |           1 GB | Standard       |
| Basic |             750 |          10 GB | Paid           |
| Pro   |           5,000 |          10 GB | Paid           |
| Scale |           7,500 |          10 GB | Paid           |

Each created media job reserves 0.05 credits automatically. After FFprobe
inspects a compression source, the reservation is adjusted before FFmpeg starts:

```text
credits = duration / 5 minutes
        * average(input pixels, output pixels) / 1080p pixels
        * output codec count
```

The result rounds up to the next 0.05 credits, with a 0.05 minimum. For example,
a five-minute 1080p source costs 1 credit per output codec; the default VP9 +
H.265 pair costs 2 credits. Image extraction and quality comparison currently
cost the 0.05-credit minimum. Success consumes the final reservation; failure,
cancellation, upload expiry, or insufficient post-analysis credits releases it.
Credits reset at the start of each UTC calendar month. Metering is automatic and
never adds a quote or confirmation step.

Compression without options produces both VP9/WebM and H.265/MP4. Audio defaults
to `auto`: audible audio is retained, silent audio is removed, and no audio track
remains absent. Result metadata includes expiring download links, SHA-256 hashes,
the exact safely displayed FFmpeg commands, and a ready-to-use HTML `<video>`
snippet.

## Local development

Requirements are Node 22.18 or newer, pnpm 11.7, SQLite support in Node, FFmpeg,
and FFprobe.

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
set -a
. ./.env
set +a
pnpm dev
```

For a local installation, set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env` to the
local executables, or leave them as `ffmpeg` and `ffprobe` when both are on
`PATH`. Run the CLI from source in another terminal:

```sh
pnpm --filter densio start -- --api-url http://localhost:3000 --help
```

Useful repository checks:

```sh
pnpm lint
pnpm format
pnpm test
pnpm typecheck
pnpm build
```

## Production deployment

### 1. Install a pinned host FFmpeg bundle

Use a trusted Linux static build for the VPS architecture. Pin an exact release,
verify its published checksum before installation, and keep FFmpeg and FFprobe
from the same build. The host directory contract is deliberately small:

```text
/opt/ffmpeg/
  bin/
    ffmpeg
    ffprobe
  VERSION
  SHA256SUMS
```

Both binaries must be executable and the build must include `libvpx-vp9`,
`libx265`, and `libsvtav1` encoders. Validate the host copy before deploying:

```sh
/opt/ffmpeg/bin/ffmpeg -hide_banner -version
/opt/ffmpeg/bin/ffprobe -hide_banner -version
/opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -E 'libvpx-vp9|libx265|libsvtav1'
```

The API repeats this capability probe at startup and fails closed if either
binary is unusable or a required encoder is absent.

Compose binds the entire directory to the same path in the container with
read-only permissions. FFmpeg still executes as a normal child process using the
VPS kernel and CPU; a container is not another virtual machine. Keeping the
bundle on the host avoids adding the large codec toolchain to each application
image. Recreate the container after atomically replacing a pinned host bundle.

### 2. Configure state and secrets

```sh
cp .env.example .env
install -d -m 0750 data
sudo chown 1000:1000 data
```

Edit `.env`. At minimum, replace `PUBLIC_BASE_URL`, `AUTH_IP_HASH_SECRET`,
`AUTH_OUTBOX_ENCRYPTION_KEY`, the Resend values, and the Stripe values. Generate
the two auth secrets independently with `openssl rand -hex 32`.
`PUBLIC_BASE_URL` must be the public HTTPS origin because it is used in emailed
confirmation links and artifact URLs. Do not commit `.env` or the `data`
directory.

Compose publishes the API only on `127.0.0.1:3000` by default, runs as UID/GID
1000, drops Linux capabilities, enables `no-new-privileges`, uses a read-only
root filesystem, and gives SQLite/media storage only the `./data` bind mount.
Change `APP_UID` and `APP_GID` together with the ownership of `./data` when the
VPS uses a different service account.

### 3. Start and verify

```sh
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 api
curl --fail http://127.0.0.1:3000/ready
docker compose run --rm api /opt/ffmpeg/bin/ffmpeg -hide_banner -version
```

SQLite migrations run before the service accepts work. The database, WAL files,
private workspaces, and retained artifacts live below `./data`. Back up the
SQLite database with a SQLite-aware online backup while the service is running,
or stop the container before copying the entire directory.

### 4. Put TLS in front

Terminate HTTPS at a reverse proxy such as Caddy or nginx and forward only to
`http://127.0.0.1:3000`. Preserve `Host`, `X-Forwarded-Proto`, and
`X-Forwarded-For`; keep `TRUST_PROXY=true` only while the application port is
restricted to a trusted local proxy. Configure the proxy's maximum request size
to match `MAX_UPLOAD_BYTES` and disable request buffering so uploads remain
streamed rather than copied into proxy temporary storage.

Authentication confirmation secrets are query parameters on
`/v1/auth/confirm`. Access logs must remove query strings or redact the `token`
parameter. Also redact `Authorization`, cookies, Stripe signatures, artifact
tokens, request bodies, and `.env` values from proxy and log-shipping pipelines.
The Compose JSON log driver rotates at 10 MB and retains five files, but log
rotation is not secret redaction.

## Resend authentication

Verify the sending domain in Resend, create a restricted production API key,
then set `RESEND_API_KEY` and an `EMAIL_FROM` address on that domain. Login is a
magic-link flow:

1. the CLI asks the API to email a one-time confirmation link;
2. it reports that confirmation is pending and polls with a separate secret;
3. the human opens the email link;
4. the CLI receives short-lived access and rotating refresh tokens and stores
   them in a mode-`0600` platform credential file.

The link secret and polling secret are distinct. Their verification values are
stored only as hashes. While delivery is pending, the durable SQLite outbox holds
the complete link in an AES-256-GCM envelope bound to that specific outbox row;
it scrubs the ciphertext after delivery or a terminal failure. Keep
`AUTH_OUTBOX_ENCRYPTION_KEY` stable while pending email drains, and keep the
challenge and retry settings from `.env.example` unless traffic measurements
justify changing them.

## Stripe subscriptions

Create recurring Stripe Prices for Basic, Pro, and Scale, then set their IDs
as `STRIPE_BASIC_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, and
`STRIPE_SCALE_PRICE_ID`. Configure the Customer Portal in Stripe, then
register an HTTPS webhook at:

```text
https://video.example.com/v1/billing/webhook
```

Subscribe it to these events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

Copy the endpoint signing secret to `STRIPE_WEBHOOK_SECRET`. Webhook signatures
are verified against the raw body and event IDs are processed idempotently. For
local Stripe CLI testing:

```sh
stripe listen \
  --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted \
  --forward-to http://127.0.0.1:3000/v1/billing/webhook
```

Use the printed `whsec_...` only in the local `.env`. The CLI commands
`billing subscribe basic`, `billing subscribe pro`,
`billing subscribe scale`, and `billing portal` return hosted Stripe URLs;
the API never handles card data. Stripe webhooks maintain the local subscription
mirror. Creating or processing a media job reads that local state and never
calls Stripe, so billing does not interrupt compression.

## Operator Pro grants

The admin command is local-only and operates directly on SQLite. An account must
complete its first login before it can receive a grant. In the production
container:

```sh
docker compose exec -e USER=operator@example.com api node dist/admin.js pro grant user@example.com
docker compose exec api node dist/admin.js pro list
docker compose exec -e USER=operator@example.com api node dist/admin.js pro revoke user@example.com
```

For development, use:

```sh
pnpm --filter @densio/api admin -- pro grant user@example.com
pnpm --filter @densio/api admin -- pro list
pnpm --filter @densio/api admin -- pro revoke user@example.com
```

An admin grant and an eligible Stripe subscription are independent. Revoking a
grant never cancels or downgrades an active paid subscription.

## CLI overview

Run the published CLI without installing it globally:

```sh
npx densio --help
npx densio capabilities --json
```

The CLI defaults to `https://api.densio.sh`. For local or self-hosted testing,
pass `--api-url http://localhost:3000` explicitly. `--api-url` takes precedence
over `DENSIO_API_URL`. Credentials default to `~/.config/densio/credentials.json`
on Unix-like systems and can be overridden with `DENSIO_CREDENTIALS_PATH`. The
rename to Densio is intentionally breaking; no previous command,
environment-variable, or credential-path aliases are read.

Build and run the workspace executable with:

```sh
pnpm --filter densio build
node apps/cli/dist/index.js --api-url http://localhost:3000 --help
```

Typical use:

```sh
densio auth login user@example.com
densio capabilities
densio compress input.mp4
densio compress input.mp4 --vp9-crf 42 --h265-crf 34 --width 1280
densio extract-images input.mp4 --interval 1 --format jpeg
densio compare-quality input.mp4 --codec vp9 --crf 32,36,40 --at 00:01:12.500
densio compare-quality input.mp4 --codec h265 --crf 26,30,34 --frame 240 --duration 3
```

Media commands upload and wait by default. `--no-wait` returns a resumable job ID;
use `densio jobs wait <job-id>` later. Ctrl-C stops only the CLI wait and does
not cancel the server job. Cancellation is explicit:

```sh
densio compress input.mp4 --no-wait --idempotency-key my-upload-001
densio jobs get <job-id>
densio jobs wait <job-id> --timeout 900
densio jobs cancel <job-id>
```

Agents should always use `--json`. It emits one schema-versioned success object
on stdout, problem details on stderr, and progress only on stderr. Inspect
`capabilities --json` before choosing codecs or limits instead of assuming what
the server supports. Artifact downloads verify the advertised SHA-256 digest:

```sh
densio artifacts download <signed-artifact-url> \
  --output ./result.webm \
  --sha256 <64-character-sha256>
```

Downloads refuse to replace an existing output by default. Add `--force` only
when replacing that path is intentional.

## Publishing the CLI

The public npm package is `densio`, its source repository is
[`pixel-point/densio`](https://github.com/pixel-point/densio), and it is licensed
under AGPL-3.0-only. Before publishing, confirm the npm account can publish the
unscoped package name.

Start from committed feature changes and a clean worktree:

```sh
./scripts/bump-cli-version.sh patch
./scripts/publish-cli.sh --dry-run
./scripts/publish-cli.sh
git push
```

The bump script also accepts `minor`, `major`, or an exact stable `X.Y.Z`. It
creates only `chore(cli): release vX.Y.Z`. The publication script verifies the
repository and the packed executable before publishing. Neither script creates
a Git tag or pushes Git state.

## Data lifecycle and retention

Source uploads and intermediate files are deleted on every terminal path:
success, validation failure, FFmpeg failure, cancellation, recovery failure, or
publication failure. Only successfully published outputs remain. They are served
through unguessable expiring URLs for 24 hours by default
(`ARTIFACT_TTL_SECONDS=86400`), then a recurring cleanup pass removes both files
and access. Expiry is not extended by download.

The worker writes a workflow into a private staging directory and publishes all
expected outputs only after every command succeeds. A failed partial workflow
therefore exposes no half-finished artifacts. Failed deletions remain retryable
rather than being silently forgotten.

Capacity planning must include the largest concurrent uploads, temporary
transcodes, published variants, SQLite WAL growth, and cleanup delay. Monitor the
filesystem containing `./data`; Docker image disk usage does not include the
bind-mounted media directory.

## Important environment controls

| Variable                         |       Default | Purpose                                      |
| -------------------------------- | ------------: | -------------------------------------------- |
| `MAX_CONCURRENT_MEDIA_PROCESSES` |           `3` | Hard global FFmpeg/FFprobe process ceiling   |
| `JOB_WORKER_CONCURRENCY`         |           `3` | Maximum jobs advanced concurrently           |
| `ARTIFACT_TTL_SECONDS`           |       `86400` | Successful output retention (24 hours)       |
| `UPLOAD_TTL_SECONDS`             |        `3600` | Incomplete upload lifetime                   |
| `MAX_UPLOAD_BYTES`               | `21474836480` | Streamed upload limit (20 GiB)               |
| `MAX_EXTRACTED_IMAGES`           |        `2000` | Extraction archive safety limit              |
| `MAX_COMPARISON_SECONDS`         |           `3` | Longest comparison sample                    |
| `AUDIO_SILENCE_THRESHOLD_DB`     |         `-50` | Peak threshold for automatic silence removal |
| `JOB_LEASE_SECONDS`              |          `60` | Durable worker claim lifetime                |
| `JOB_HEARTBEAT_SECONDS`          |          `10` | Active job lease renewal interval            |

Keep `JOB_HEARTBEAT_SECONDS` lower than `JOB_LEASE_SECONDS`. The full, commented
configuration surface is in `.env.example`.
