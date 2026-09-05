export const apiOverview = [
  "Agent-first video compression, image extraction, quality comparison, and HEVC HLS packaging. Media inspection, codec policy, credit accounting, execution, and cleanup are server-owned.",
  "",
  "## Upload → submit → observe → download",
  "",
  "1. Authenticate and list memberships with `GET /v1/organizations`; first registration creates a default organization. Explicitly pin its ID for all media operations. `GET /v1/capabilities` is anonymous common policy; `GET /v1/organizations/{organizationId}/capabilities` includes that organization’s entitlements and shared credits. Fetch agent instructions with `GET /v1/skill`.",
  "2. Declare a reusable source with `POST /v1/organizations/{organizationId}/sources` (`filename` and exact `bytes`). PUT the raw file to the returned upload action with bearer authentication. Inspect the response or poll `GET /v1/organizations/{organizationId}/sources/{id}` until `ready`; a `failed` source includes its problem.",
  "3. Submit directly with `POST /v1/organizations/{organizationId}/jobs`, a required `idempotency-key`, and `{sourceId, workflow, options?, constraints?, storage?, clientReference?}`. The API validates intent, resolves shared defaults, freezes an execution snapshot, and atomically reserves the exact quote with job creation. `constraints.maxCredits` rejects before spending. Compression, extraction, comparison, and HLS share this flow.",
  "4. If `MEDIA_DECISION_REQUIRED` (409) is returned, read `details.decision.choices` and resubmit with explicit frameRate options; no job or hold exists yet. Optional `POST /v1/organizations/{organizationId}/execution-plans` previews resolved intent and price. Its resolve and execute actions remain available; uploads, inspection, storage changes, and downloads need no plans.",
  "5. Follow `statusUrl` or poll `GET /v1/organizations/{organizationId}/jobs/{id}`. Resume observation with the finite JSON event pages at `GET /v1/organizations/{organizationId}/jobs/{id}/events`. Recover a lost submission using `GET /v1/organizations/{organizationId}/jobs/lookup` with exactly one execution idempotency key or client reference.",
  "6. Read stable artifact IDs from the successful result and live artifact inventory. Authorize each retained artifact with `POST /v1/organizations/{organizationId}/artifacts/{artifactId}/authorize`, then download from its returned short-lived URL. Keep the artifact ID, not the download URL, as identity.",
  "",
  "## Retries, spending, and retention",
  "",
  "Source creation, plan creation, and plan resolution accept optional idempotency keys; direct submission and plan execution require one. Keys contain 1–200 printable characters. Retry the same endpoint with the same key and intent to recover the original resource (`200`, `replayed: true`); changed intent returns `409`. New resources return `201`. An execution replay recovers the same job even after source or plan expiry; use its status URL for progress.",
  "",
  "`maxCredits` is checked before reservation, against the exact quote. `maxOutputBytes` limits the aggregate published output bytes, not each file or the input. It is checked after encoding: an oversized result fails without publishing artifacts but the completed encoding is charged. Normal failure or cancellation releases the hold. Execution guards can tighten plan constraints, not relax them.",
  "",
  "Plan snapshot state and live `availability` are separate. Only available plans expose legal execution or resolution actions. Terminal job receipts are immutable; artifact expiry or deletion changes live availability, not the completed job's state or historical receipt. Source and output retention are independent of short-lived download grants. Source and artifact DELETE operations leave history and revoke access before physical cleanup; a cleanup failure can return `500` after revocation, and background maintenance retries it. Deleting a source does not delete already-attached job inputs or outputs. Cleanup also runs automatically at startup and periodically; there is no public cleanup endpoint.",
  "",
  "## HLS VOD packages",
  "",
  "Use workflow `hls` with optional `options.crf.h265`, `options.rateControl.mode` (`capped-crf` or `crf`), `options.audio`, `options.frameRate`, and `options.ladder`. A custom ladder is `{mode: 'custom', renditions: [{height: 360}, {height: 720, crf: {h265: 28}}]}`. HLS encodes each rendition from the original source with HEVC Main10, veryslow, one shared AAC track, aligned closed GOPs, and fMP4 VOD segments around six seconds. Up to three source-aware renditions preserve aspect ratio without upscaling. Initial inputs must be progressive SDR; HDR/BT.2020 and interlaced inputs return HLS_SOURCE_UNSUPPORTED (422). H.264 fallback, AV1 HLS, VP9 HLS, live streaming, DRM, and private streaming sessions are not included.",
  "",
  "CRF precedence is rendition override, request override, then the shared compression default (H.265 currently 30). Capped CRF is the default; resolved per-rendition maxVideoBitrateBps and videoBufferSizeBits can constrain quality in difficult scenes. Uncapped crf has no ceiling and rejects explicit caps. Defaults and explicit CRFs never change during benchmarking or packaging. Published BANDWIDTH/AVERAGE-BANDWIDTH reflect measured segments and shared audio.",
  "",
  "A completed HLS job returns one hls.zip artifact and a package identity. Temporary, managed public/private, and customer destinations use the same job. Storage retains an authoritative inventory of all playlist/init/media members. Only a fully verified ready public video exposes hls.playbackUrl, ending in master.m3u8; HEVC support depends on the browser, OS, hardware, and player. CDNs must provide correct playlist MIME, CORS, and media ranges. Job completion precedes delivery readiness; retrying delivery does not re-encode or charge processing credits.",
  "",
  "POST /v1/organizations/{organizationId}/videos/{videoId}/package/authorize returns the package inventory and one 15-minute download base URL. Append the percent-encoded member path to retrieve and verify each member. This supports private package download even after the temporary ZIP expires. Grants check current membership, video state, and visibility revision and use private/no-store responses. Capacity, export, withdrawal, deletion, and retention include every package member. maxOutputBytes is enforced against both package bytes and ZIP bytes before publication.",
  "",
  "HLS scratch usage is monitored separately from output size and managed capacity. HLS_MAX_SCRATCH_BYTES defaults to 20 GiB for local package and ZIP files together, with a 64 MiB filesystem reserve. HLS_SCRATCH_LIMIT_EXCEEDED is a job failure requiring operator capacity recovery, not an instruction to change CRF.",
  "",
  "## Organizations and billing",
  "",
  "All media and billing control endpoints require an explicit organization ID. There are no unscoped aliases. Users are actors; sources, plans, jobs, artifacts, credits, and Stripe subscriptions belong to organizations. Owner/admin/member roles all share media and one monthly allowance; there is no seat pricing. Only owners manage billing, admin roles, ownership transfer, and closure. Invites expire after seven days and require the addressed verified email. Creating/joining never changes defaults; removal repairs defaults without moving data.",
  "",
  "Checkout requires a 1–200 character idempotency key and freezes one organization intent. Retry it unchanged after uncertain responses; do not use a new key to bypass an unresolved checkout. Portal URLs have provider-defined lifetimes and no fabricated expiresAt. DELETE organization returns 202 while deleting and 200 once deleted. Active work/uploads, nonterminal subscriptions, open/uncertain checkouts, and unresolved billing operations block closure; cancel-at-period-end remains nonterminal. Cleanup removes media bytes before completion and retains audit, ledger, and receipt history.",
  "",
  "Offboarding revokes only grants minted by that membership; rejoining does not revive old grants. Binary downloads recheck live organization/membership access and use private, no-store caching, including conditional 304 responses. Never send access-token headers to a granted download URL.",
  "Completed checkout and subscription evidence commit atomically. Persistent checkout uncertainty requires platform-operator inspection/reconciliation on the server; it never permits a replacement payment without evidence. Contact retries reconcile the same saved email, including beyond 24 hours. Failed portal minting releases its temporary operation lock. Physical cleanup waits for active writers and child processes, retries pending resources in bounded pages, and records durable completion; only organization state `deleted` confirms closure cleanup is complete.",
  "",
  "## Authentication and response handling",
  "",
  "Use `Authorization: Bearer <access-token>` for owned resources. Authentication endpoints establish and refresh access; public capabilities expose common policy only. Authorized download URLs carry their own bearer credential: do not log or publish them.",
  "",
  "Source, plan, job, and artifact control operations return JSON success envelopes with `ok`, `schemaVersion`, `correlationId`, and `data`. Failures use `application/problem+json` with a stable `code`, `retryable`, and `suggestedAction`; preserve `correlationId` for diagnostics. Downloads are binary streams, and browser authentication confirmation returns HTML. The schemas and status codes below are generated from the registered HTTP routes and shared wire contracts.",
].join("\n");

export const apiTags = [
  {
    name: "Organizations",
    description:
      "Manage memberships, invitations, defaults, ownership, audit history, and restart-safe closure.",
  },
  {
    name: "Capabilities",
    description: "Discover server policy and effective organization entitlements before planning.",
  },
  {
    name: "Prepared sources",
    description:
      "Upload once, inspect, reuse, list, and delete source media independently of jobs.",
  },
  {
    name: "Execution plans",
    description:
      "Review immutable intent and exact quotes, resolve decisions, then execute with an idempotency key.",
  },
  {
    name: "Media jobs",
    description:
      "Observe execution, recover submissions, page through durable events, and cancel work.",
  },
  {
    name: "Artifacts",
    description:
      "Manage stable output identities separately from retention and short-lived download grants.",
  },
  {
    name: "Authentication",
    description: "Sign in through email confirmation and manage bearer access sessions.",
  },
  {
    name: "Billing",
    description:
      "Inspect credits and entitlements, manage subscriptions, and receive signed Stripe events.",
  },
  {
    name: "Skill",
    description: "Fetch the current agent workflow instructions and command references.",
  },
  { name: "System", description: "Check process health and media toolchain readiness." },
];
