# Production release verification — 2026-09-05

## Scope

Release all pending Densio changes to `main`, deploy to `api.densio.sh` through
`/Users/alex/Projects/prime-server`, and verify real account, organization, billing,
media, and runtime skill workflows. This report records evidence and limitations;
pending checks are not passes.

## Deployment boundaries

- SSH target: `primeui@91.98.176.194`.
- Densio Compose project: `densio`; service: `api`.
- Densio state: `/home/primeui/apps/densio/data`.
- Existing release: `75d6d07380f855de588a4f67a9b8853ba15d3e4c`.
- Other applications and Traefik must retain their containers and data.
- No broad Docker cleanup, shared database modification, or edge deployment.
- Secrets, database contents, login tokens, and signed URLs are excluded from this report.

## Findings

| ID       | Finding                                                                                                                                                                       | Action / status                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROD-001 | Organization migration refuses a nonempty legacy database. Production has three users, 53 terminal jobs, and one active test subscription. No jobs are running.               | Completed Densio-only cutover with intact protected backup. Previously registered email signed in and completed compression. Legacy test subscription cleanup pending.                                                                                                       |
| PROD-002 | Local CLI source is version 0.1.3 while npm latest is 0.1.4; local npm publishing authentication is absent.                                                                   | Prepared and pushed CLI 0.2.0 through the release script. Full publishing dry run passed under isolated Node 22.18.0/Corepack pnpm 11.7.0. Awaiting npm authentication and explicit npm publication approval.                                                                |
| PROD-006 | Stripe test portal allows cancellation but disables plan updates.                                                                                                             | Enabled price changes for the three configured Densio test products, preserved cancellation, and disabled quantity changes. Read-back confirmed the settings. Basic checkout and upgrade to Pro completed in the hosted sandbox portal; Basic webhook entitlement confirmed. |
| PROD-003 | Production has no `STORAGE_CONFIG_JSON`. Stripe test mode, active monthly USD prices (Basic $9 / Pro $29 / Scale $59), and the enabled Densio webhook were verified directly. | User explicitly authorized Cloudflare R2 provisioning. Configured three dedicated buckets, media.densio.sh, lifecycle and CORS policies, restricted runtime and purge tokens. Basic provider round trip passed. Temporary provisioning token revoked.                        |
| PROD-005 | The Mac ran out of disk space during temporary Node extraction.                                                                                                               | Removed only this run’s incomplete download. Moved validation to a disposable server container (8 CPUs, 12 GB limit).                                                                                                                                                        |
| PROD-004 | Default local Node is 25.8.1 and Corepack is absent from PATH.                                                                                                                | Validation runs in an isolated Node 22.18.0 container with Corepack pnpm 11.7.0, no production credentials, a separate filesystem, and the read-only FFmpeg mount.                                                                                                           |

### PROD-007: R2 object version incompatibility

Real managed saves and HLS hosting reached successful encoding, then retried with
`STORAGE_PROVIDER_UNAVAILABLE`. A live adapter probe isolated HTTP 501 on HEAD with
an object version returned by R2. R2 returns `x-amz-version-id` identities but does
not implement S3 version-addressed operations. The fix disables version addressing
for R2 endpoints on writes, reads, copies, and deletion, including persisted retry
state. Ordinary S3 version handling remains enabled. Local HTTP regression testing
failed before the fix and passed afterward. Full `pnpm format`, `pnpm check`, and `pnpm build` passed; deployed as `9dc1452`. Existing video/HLS transfers recovered without re-encoding. The fixed live adapter completed multipart create/upload/complete, HEAD, exact readback and deletion.

## Verification ledger

| Check                                                    | Result                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Initial host health and unrelated container inventory    | Passed; Densio and all healthchecked services healthy.                                      |
| Densio scope, database size, and active jobs             | Passed; read-only inspection, no active jobs.                                               |
| Frozen dependency installation                           | Passed with frozen lockfile, Node 22.18 / pnpm 11.7.                                        |
| Root formatting and `pnpm check`                         | Passed again with storage fix: 1,115 tests, typechecks, lint, formatting.                   |
| Workspace build and packaged CLI dry run                 | Passed; npm publication pending authorization/login.                                        |
| Production Docker image build                            | Passed for 1ea28df; fix image pending.                                                      |
| Densio backup and cutover                                | Passed. Backup path below.                                                                  |
| Existing email login                                     | Passed; same email, new Free organization, completed compression.                           |
| Fresh alias registration and email delivery              | Passed +1 and +2 login emails; invitation email delivered.                                  |
| Default Free compression and downloaded media            | Passed VP9/Opus + H.265/AAC; sizes and SHA-256 verified.                                    |
| Stripe test checkout, webhook, plan change, portal       | Basic checkout/webhook and portal Pro upgrade passed; remaining checks pending.             |
| Organization edit, invitations, roles and isolation      | Rename, invite, accept, shared access, outsider denial and member billing denial passed.    |
| Prepared sources, comparison, extraction, AV1, trim, HLS | All six encodings succeeded; advanced artifact inspection and durable HLS delivery pending. |
| Runtime skill version and references                     | Served CLI 0.2.0 and reference hashes match source; npm bootstrap pending.                  |
| Final health, logs, and unrelated container comparison   | Pending.                                                                                    |

## Account compatibility

The new schema changes ownership from users to organizations and intentionally does
not migrate legacy account state. A fresh database means previous sessions must
sign in again; old jobs, usage history, and subscription mappings are not retained
in the active database. Previous data will remain in the protected Densio backup.
The prior email sign-in check and handling of the existing Stripe test subscription
must be completed before this release is considered verified.

## Release evidence

- Main release commit: `1f9e397` (all 596 changed files, including generated migration snapshots).
- CLI release commit: `1ea28df` (`densio@0.2.0`), pushed to `origin/main`.
- Linux check: 1,109 tests across 189 files; all typechecks and builds passed; zero lint warnings/errors.
- Local release commands use `/tmp/densio-production-20260905/node-v22.18.0-darwin-arm64/bin` first in PATH. The Homebrew pnpm launcher delegated versioning to npm and failed on `workspace:*`; the Corepack-managed pnpm 11 command completed correctly. No application workaround was added.

## Production resources and recovery

- Running source/image: `1ea28dfdcd9890e6ef424e8217ee2843a23f3571`.
- Densio backup: `/home/primeui/apps/densio/backups/20260905-before-organizations`; owner-only directory, original data and runtime environment, SQLite integrity check passed.
- Public/private/staging R2 buckets: `densio-prod-media-public`, `densio-prod-media-private`, `densio-prod-media-staging` (WEUR).
- Public delivery: `https://media.densio.sh`; R2 development URLs disabled on all three buckets.
- Lifecycle: abort incomplete multipart after two days on all buckets; delete objects after two days on staging only.
- Runtime credential restricted to these three buckets; cache purge credential restricted to densio.sh. Secret configuration lives only in protected, ignored deployment environment files.
- Buckets were provisioned through Cloudflare API/UI. Import them before a future Terraform apply; no Terraform state was created by this run.
- No other application database or bucket was modified.

## Test evidence

- Existing email organization: `08c97839-f8af-4b4e-83d6-34acc3f0fe37`; compression job `ab36727d-edf1-4134-a2bc-774035df522c` succeeded.
- Alias +1 organization: `c2dc09c3-dc06-42e2-b2dd-a88d28b0e776`, renamed to Densio production verification.
- Reusable six-second 640×360/24 fps source: `3ef9ed7d-778e-491b-95f0-aa3a7c4c950a`.
- Default compression: `f80a8e64-0765-49fe-8f66-e0848fd6c580`; original 856,908 bytes; VP9 332,917 and H.265 356,028 bytes, audible audio preserved, independent FFprobe and SHA-256 verification passed.
- Mac `/tmp` is a symlink. The CLI correctly rejected artifact writes through it (`ARTIFACT_OUTPUT_UNSAFE`). Resuming the same completed jobs into canonical `/private/tmp` paths succeeded without another encode or charge.
- Hosted Stripe checkout displayed Sandbox and used the authorized 4242 test card. Basic status: active Stripe entitlement, 750 monthly credits, 0.05 used, 0 reserved after initial compression.
- Before invitation, alias +2 received `ORGANIZATION_NOT_FOUND`; after acceptance it could read the shared source. Member portal creation returned `ORGANIZATION_OWNER_REQUIRED` (403).

### PROD-008: R2 anonymous authorization response

Customer-storage validation rejected the private R2 staging bucket because R2
returns HTTP 400 with `InvalidArgument` / `Authorization` for unsigned requests.
Validation previously accepted only 403/404. Added bounded recognition of that
specific S3 authorization error; unrelated 400 errors, oversized bodies, 200/206,
and server errors still fail. Local HTTP test failed before the fix and passed
afterward. Full formatting, typecheck, lint, 1,123 tests and build passed; deployment pending.

### Additional verified behavior

- Pro upgrade confirmed by API: 5,000 monthly credits, 0.30 used, zero reserved. Hosted portal downgrade to Basic completed; API readback pending.
- Billing contact changed to alias +2 independently of owner login.
- Removing alias +2 invalidated its artifact grant (404). Replaying its accepted invitation returned 409 and did not restore membership.
- Legacy Stripe subscription was verified as test mode, matched the original email/customer, and canceled without invoice or proration. No other subscription was changed by this cleanup.
- HLS is ready at its public URL, with `application/vnd.apple.mpegurl`, CORS `*`, HEVC Main10 rendition and shared AAC track.
- Private stored-video download passed using fresh CLI grants.
- Python urllib requests to the public hostname receive Cloudflare browser-integrity error 1010. Node/CLI requests and the server delivery verifier succeed; browser verification remains pending. This is recorded separately from R2 storage failures.

### PROD-009: Cached 404 after public restoration

After public → private → public, R2 contained the correct bytes and the server's
verification passed, but another Cloudflare location still returned a cached 404.
An exact-URL purge restored correct bytes. Added batched managed URL purge after
all output writes and before public verification/readiness, for both initial saves
and visibility changes. Regression tests simulate negative caching and a failed
purge, then recover the same transfer. Customer CDN configuration remains customer
owned. Full formatting, typecheck, lint, 1,125 tests and build passed; deployment pending.

### PROD-010: Cloudflare browser TTL overrides media policy

Live public responses advertise `max-age=14400`, overriding Densio's stored
`max-age=60`. This violates the application's bounded public-withdrawal policy.
A Cloudflare rule must respect origin browser cache headers for media.densio.sh.
Configuration fix and readback pending.
