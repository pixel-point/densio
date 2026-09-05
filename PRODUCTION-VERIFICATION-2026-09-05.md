# Production release verification — 2026-09-05

## Result

The new Densio API is deployed and the production journeys below passed. Three
application defects were reproduced, fixed with regression tests, committed,
pushed to `main`, and redeployed. R2 and Stripe test configuration were corrected.
The final application commit is `480b1a8`; subsequent report-only commits do not
change the application.

**The public CLI release is complete:** `densio@0.2.0` is published as npm's
`latest`. A fresh-cache `npx` installation returned the required CLI/skill version
metadata, all six reference documents matched the repository, and a production
login → upload → compression → verified download journey passed. The earlier npm
authentication/2FA blocker is resolved. No known release blocker remains from this
verification scope.

## Scope and boundaries

- Source repository: `/Users/alex/Projects/densio`; all original pending work was committed and pushed to `main`.
- Deployment setup: `/Users/alex/Projects/prime-server`; its tracked working tree remains unchanged. Runtime secrets are in its protected, ignored Densio environment file.
- Host: `primeui@91.98.176.194`; Compose project `densio`, service `api`.
- API: `https://api.densio.sh`; media: `https://media.densio.sh`.
- Active database/media directory: `/home/primeui/apps/densio/data`.
- All 25 unrelated application containers retained their original container IDs. No other application database, bucket, or deployment was modified.
- The independent SiteOS search indexer restarted during this session with the same container ID and an existing restart count above 300. This task did not restart or modify it.
- No broad Docker cleanup, shared database modification, edge deployment, or live Stripe payment occurred.
- Secrets, authentication tokens, database contents, and signed URLs are excluded from this report.

## Findings and fixes

| ID       | Finding                                                                                                                                                           | Resolution                                                                                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PROD-001 | The organization migration intentionally rejects a populated legacy schema. Production contained three users, 53 terminal jobs, and one active test subscription. | Used the explicitly authorized Densio-only database reset with a recoverable backup. The previously registered base email signed in again and compressed a video. The exact legacy test subscription was verified and canceled without invoice or proration.                                  |
| PROD-002 | Local CLI was 0.1.3, npm latest was 0.1.4, and npm publishing authentication was absent.                                                                          | Released source 0.2.0 with the required script and pushed it. After an initial `EOTP` rejection, the user replaced the token with publishing 2FA bypass enabled. All release checks passed; 0.2.0 is now npm latest. Fresh npm bootstrap and production account/media checks passed.          |
| PROD-003 | Production had no managed-storage configuration.                                                                                                                  | Provisioned three dedicated R2 buckets, public domain, CORS, lifecycle policies, restricted runtime credentials, a zone-specific purge token, and the encryption key configuration.                                                                                                           |
| PROD-004 | Default local Node was 25.8.1; the Homebrew pnpm launcher delegated versioning to npm and failed on `workspace:*`.                                                | Used isolated Node 22.18.0 and Corepack-managed pnpm 11.7.0. The required release script then worked. No application workaround was added.                                                                                                                                                    |
| PROD-005 | Local disk exhaustion interrupted temporary Node extraction.                                                                                                      | Removed only this run's incomplete download. Initial complete validation ran in a disposable server container with separate files, no production credentials, and constrained resources. Later local checks also passed.                                                                      |
| PROD-006 | Stripe's test portal disabled plan changes.                                                                                                                       | Enabled price changes for the three existing Densio test products, retained cancellation, and disabled quantity changes. Basic checkout, Pro upgrade, Basic downgrade, cancellation scheduling, and renewal were exercised in the hosted sandbox UI.                                          |
| PROD-007 | R2 returns `x-amz-version-id` identities but rejects version-addressed S3 requests with HTTP 501. Managed saves stalled after uploading.                          | Commit `9dc1452` suppresses version addressing for R2 writes, reads, copies, and deletion, including persisted retry state. Standard S3 version handling is preserved. Existing video/HLS transfers recovered without another encode or charge.                                               |
| PROD-008 | Private R2 endpoints return HTTP 400 with `InvalidArgument` / `Authorization` for anonymous requests; validation only accepted 403/404.                           | Commit `e291aa2` recognizes that specific, bounded authorization response. Unrelated errors, oversized bodies, and readable responses still fail. The original connection then validated successfully.                                                                                        |
| PROD-009 | After public → private → public, another Cloudflare location could retain a cached 404 even though origin bytes and the server-side check were correct.           | Commit `480b1a8` purges managed URLs in batches after writes and before public verification/readiness, for initial publication and visibility changes. Regression tests cover cached misses and failed-purge recovery. The repeated production cycle succeeded automatically.                 |
| PROD-010 | Cloudflare changed the stored browser TTL from 60 seconds to four hours, invalidating Densio's withdrawal timing.                                                 | Added a rule for exactly `media.densio.sh`: respect origin browser TTL, use origin edge cache headers and bypass when absent, and disable stale serving while revalidating. Live responses now preserve `max-age=60, s-maxage=86400, must-revalidate`; missing-object responses bypass cache. |
| PROD-011 | Cloudflare Browser Integrity Check rejected ordinary Python downloads with error 1010.                                                                            | Disabled that check only for the public media hostname. Python downloads now return 200 with matching bytes/hash; API and other hostnames retain their settings.                                                                                                                              |

## Verification ledger

| Check                               | Result and evidence                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain and frozen dependencies   | Passed with Node 22.18.0, pnpm 11.7.0, and `pnpm install --frozen-lockfile`.                                                                                                                                                                                                                                                                   |
| Formatting, typechecks, tests, lint | Final `pnpm format` and `pnpm check` passed: 1,125 tests across 191 files, typechecks, lint, and formatting verification.                                                                                                                                                                                                                      |
| Build and package                   | `pnpm build` passed after the fixes. CLI 0.2.0 publishing dry run passed lint, format, tests, typechecks, build, pack, package install and help checks.                                                                                                                                                                                        |
| Regression evidence                 | R2 version test, R2 anonymous-denial test, and cached-miss tests failed before their respective fixes and passed afterward. Tests use controlled local provider boundaries.                                                                                                                                                                    |
| Production container                | Each actual Docker image built and deployed successfully. Latest implementation container was healthy with zero restarts; `/ready` returned 200.                                                                                                                                                                                               |
| Database integrity                  | Final SQLite `integrity_check` returned `ok`. Seven jobs succeeded; no queued/processing jobs or retrying transfers remained.                                                                                                                                                                                                                  |
| Existing email account              | Previously registered `lnikell@gmail.com` confirmed a real login email and completed VP9/H.265 compression.                                                                                                                                                                                                                                    |
| New registrations                   | `lnikell+1@gmail.com` and `lnikell+2@gmail.com` registered through real delivered magic links. Session refresh worked during the extended run.                                                                                                                                                                                                 |
| Organization behavior               | Rename, invitation email delivery, acceptance, shared-source access, removal, reinvitation, role promotion, audit listing, ownership transfer and restoration passed.                                                                                                                                                                          |
| Isolation and roles                 | An outsider received 404; members and admins received 403 for owner-only billing actions. A removed member's grant returned 404 and stayed invalid after reinvitation. Replaying the old invitation returned 409.                                                                                                                              |
| Organization closure                | Deleted the empty alias +2 organization. It reached `deleted` automatically and its default selection moved to the remaining membership. The configured cleanup cadence is ten minutes.                                                                                                                                                        |
| Billing                             | Hosted Sandbox checkout with the authorized 4242 card activated Basic through the webhook. Pro upgrade produced 5,000 monthly credits; downgrade restored Basic. Billing contact changed independently of owner login. Cancellation at period end and renewal both worked; final test subscription is active Basic with cancellation disabled. |
| Source reuse and guards             | Repeating the upload key recovered the same source. Free AV1 returned `PLAN_ENTITLEMENT_REQUIRED`; a 0.01-credit guard rejected the exact 0.05-credit quote before admission.                                                                                                                                                                  |
| Free compression                    | Six-second, 640×360, 24 fps input produced VP9/Opus and H.265/AAC, with audible audio retained. Independent FFprobe and SHA-256 checks passed.                                                                                                                                                                                                 |
| Advanced compression                | AV1 output was independently verified as `yuv420p10le`. The browser decoded and played the public six-second AV1 output to completion.                                                                                                                                                                                                         |
| Trim                                | Frames 24 through 96 produced an exact three-second H.265/AAC clip.                                                                                                                                                                                                                                                                            |
| Image extraction                    | Two-second WebP extraction produced three frames and a timestamp manifest in the ZIP.                                                                                                                                                                                                                                                          |
| Quality comparison                  | Two H.265 CRF candidates produced matched sample windows, previews, SSIM/PSNR results, a Pareto set and a recommendation.                                                                                                                                                                                                                      |
| HLS                                 | Eight package files downloaded with CLI byte/hash verification. Playlists had the correct MIME type and CORS; FFprobe confirmed HEVC Main10 plus AAC. All eight public URLs returned 404 after complete package deletion. Browser-specific HEVC/HLS player support was not separately certified.                                               |
| Managed public storage              | Public GET matched stored SHA-256 and byte counts. Ranged GET returned 206 with exact Content-Range and CORS `*`.                                                                                                                                                                                                                              |
| Visibility and recovery             | Public withdrawal reached private readiness with old URLs returning 404; authenticated private download passed. Republishing retained the exact URLs and bytes. The final cycle passed without manual purge.                                                                                                                                   |
| Customer storage                    | Real R2 connection validated multipart upload/readback/abort/deletion and private denial. Direct source upload, export, verified download and credential-version rotation passed.                                                                                                                                                              |
| Disconnect and cleanup              | Forget/disconnect preserved customer objects and erased saved connection credentials. After verifying preservation, this run removed only its isolated test prefix and purged those exact URLs.                                                                                                                                                |
| Runtime skill                       | Published CLI 0.2.0 was installed with a fresh npm cache. Bootstrap retained CLI/skill versions and the reference index; all six reference contents/hashes matched the repository. Stale version requests returned `SKILL_VERSION_CHANGED` with exit 5 and empty stdout.                                                                       |
| Other applications                  | All 25 unrelated container IDs were unchanged. No unrelated deployment was performed.                                                                                                                                                                                                                                                          |

## Account compatibility and backup

The new schema changes ownership from users to organizations. The authorized fresh
database cutover retained no old sessions, jobs, usage history, or subscription
mappings in the active database. Existing users must sign in again; ordinary
registration creates their new Free organization. This was verified using the
previously registered base email. It is not a data migration.

The recoverable backup is
`/home/primeui/apps/densio/backups/20260905-before-organizations`. Its protected
owner-only directory contains the original complete data directory and runtime
environment. The original SQLite integrity check passed before cutover. Only the
legacy subscription identified from that Densio database was canceled, after
checking test mode, customer identity, email and legacy user metadata.

## Cloudflare resources

- Account: `a56bc287ba527e8d0d3c0d26bb87559a`; Densio zone: `ffd1f294b9eb1487463722f4b6f8b4fd`.
- Buckets: `densio-prod-media-public`, `densio-prod-media-private`, `densio-prod-media-staging`, in WEUR with Standard storage.
- All three buckets have R2 development URLs disabled. Only the public bucket has `media.densio.sh`, with TLS 1.2 minimum.
- Lifecycle: abort incomplete multipart uploads after two days on all three buckets; expire stored objects after two days on staging only. Public/private objects have no bucket expiry.
- Public CORS allows GET/HEAD, origins `*`, Range and conditional-read headers; exposes size/range/ETag response headers.
- Runtime token is restricted to object read/write on these three buckets. Purge token is restricted to the Densio zone. Temporary provisioning token was revoked.
- Cache rule `0d3289300e3242b2b1f82d9ef17f9607` and client rule `1b09e4ae425a4b3092c02cf2ddf7f78f` match only `media.densio.sh`.
- Provisioning used Cloudflare API/UI. No Terraform state was created. Import existing resources before a future Terraform apply; the current module does not own the two zone rules.

## Remaining test state

- Test organization: `c2dc09c3-dc06-42e2-b2dd-a88d28b0e776`, named **Densio production verification**. Alias +1 is owner; alias +2 is admin. Its billing contact is alias +2 and its subscription is Basic in Stripe test mode.
- Existing-email organization: `08c97839-f8af-4b4e-83d6-34acc3f0fe37`, Free.
- Empty alias +2 organization `c5d871fb-f4fb-4883-ab80-281d94c655cd` is deleted.
- Two ready managed videos remain for inspection: `681d28d4-ebd4-4173-b860-c64c2997ed79` (VP9/H.265) and `1a8a2d6b-ab4a-4d84-a25e-53c592b3b222` (10-bit AV1).
- Public bucket contains their three verified objects; private and staging buckets are empty. The HLS sample and customer export are deleted/forgotten; the customer connection is disconnected.
- Test CLI sessions were logged out; temporary credential copies, hosted checkout/portal URLs, and the canary environment were removed. Active deployment credentials and the protected rollback backup remain intact.
- Final Basic balance after the npm release check: 749.65 credits available, 0.35 used, zero reserved. Managed storage uses 987,552 bytes with zero reserved, transient, or cleanup-pending bytes.
- Processing state before the npm follow-up: seven successful jobs, two ready sources and one deleted source. The follow-up added one successful job and one source that was subsequently deleted. Temporary artifacts retain their normal automatic expiry.
- Storage state: eight successful transfers and one intentional canceled transfer from forgetting the export; no pending/retrying transfers. Two ready videos and two deleted videos.

## Release history and operational notes

- `1f9e397`: committed all 596 original changed files, including generated migration snapshots.
- `1ea28df`: bumped CLI to 0.2.0 through `scripts/bump-cli-version.sh` and pushed to main.
- `9dc1452`, `e291aa2`, `480b1a8`: production storage fixes described above, each validated and deployed.
- Initial Linux validation used a separate Node container limited to eight CPUs and 12 GB RAM, with read-only host FFmpeg and no production credentials. Missing git/unzip were validation-container prerequisites, not application failures.
- Mac `/tmp` is a symlink. CLI materialization correctly refused that path with `ARTIFACT_OUTPUT_UNSAFE`; resuming the same completed jobs under canonical `/private/tmp` succeeded without another encode or charge.
- Local test commands explicitly pinned the API origin, disposable credentials and organization. Production checks were separate from deterministic unit/integration/E2E tests. Scheduled synthetic commands were not run.
- No fresh-agent discovery evaluation or long-duration load/retention soak is claimed by this report.

## Published CLI verification

- Published `densio@0.2.0` through `scripts/publish-cli.sh`, following the successful dry run. The script passed lint, formatting, all 1,125 tests, typechecks, build, archive allowlist, isolated package install, and executable help checks under Node 22.18.0 / pnpm 11.7.0.
- npm confirmed `latest = 0.2.0`. Registry archive SHA-1 is `21f4002f1412a17360573fcaf6fe3225f483b62e`, matching the locally tested archive.
- Bootstrap ran through `npx --yes densio@latest` outside the source repository with a fresh npm cache and disposable credentials. Subsequent commands pinned `densio@0.2.0`, the production API origin, and the test organization.
- Skill version: `sha256:0d702c368944e9ab38dff2ff9f3ee23d91bcf69d17e51f7dffdb8828eeb3c09f`. All six reference documents matched their hashes and repository contents. A deliberately stale version returned `SKILL_VERSION_CHANGED`, exit 5, and no stdout.
- Existing alias +1 completed a fresh email-confirmed login. Auth status and organization discovery returned its existing owner membership. Disposable credentials were written with mode 600.
- The browser tool reported `ERR_BLOCKED_BY_CLIENT` when displaying the confirmation page. The confirmation request still completed: CLI polling succeeded and authenticated API requests verified the session. This follow-up therefore verifies login completion, but does not claim that the confirmation page rendered in the in-app browser.
- Uploaded source `201af89f-6942-459b-947b-a59162d87d0f` (856,908 bytes, six seconds, 640×360, 24 fps). Job `638d8197-545b-4c8e-a779-253d0ee704e9` succeeded and charged 0.05 credits.
- Downloaded VP9/Opus (332,917 bytes) and H.265/AAC (356,028 bytes). Independent SHA-256 and byte checks, FFprobe frame counts (144 each), and complete FFmpeg decoding passed. Audio was retained. Container durations were 6.024 and 6.016 seconds; an initial scratch check used an overly strict 20 ms duration tolerance, so verification instead counted the complete video frames and decoded both streams.
- Exact upload and job retries retained their original IDs and billing receipt. Basic balance remained 749.65 available, 0.35 used, and zero reserved after retry.
- Published CLI also downloaded both variants of the existing managed R2 video `681d28d4-ebd4-4173-b860-c64c2997ed79`; independent byte/hash checks passed.
- Deleted only the follow-up's two temporary artifacts and source; descriptors confirmed `deleted`. Existing managed videos remain available. Logout revoked the session, subsequent auth status was unauthenticated, and the disposable credentials file was removed.
- Local output evidence is under `/private/tmp/densio-production-20260905/npm-release-verification/output`; managed-download evidence is in the adjacent `managed-output` directory. No bearer credentials or signed URLs are included in this report.
- Final production check: `/ready` returned 200; `densio-api-14` was running, healthy, with zero restarts on image `densio-api:b231e581b3a44b0372ea50b0fa3c7d4221f012a3`. CLI publication required no application changes or server redeployment.
