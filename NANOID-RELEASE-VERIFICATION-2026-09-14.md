# Nano ID release verification — 2026-09-14

## Release

- User change: `197f031fc9dca175e331738fd44478406f044f7f`.
- Release tooling fix: `7fdea88`.
- Deployed source and CLI release commit: `868675c04b944724ce3c9834223f3a5526bdfa89`, pushed to `main`.
- Production: `densio-api-21`, image `densio-api:868675c04b944724ce3c9834223f3a5526bdfa89`, healthy at `https://api.densio.sh/health`.
- Published `densio@0.2.1`; npm `latest` resolves to `0.2.1`. A fresh registry installation contains the standalone executable and no runtime dependencies.
- All 47 containers belonging to other hosted applications retained their original container IDs.

No database reset or ID rewrite was needed. Shared contracts still accept opaque nonempty strings, including legacy UUIDs. New organization IDs contain 12 case-sensitive alphanumeric characters; other new application record IDs contain 21.

## Backup and data preservation

Created an online SQLite backup before deployment at:

`/home/primeui/apps/densio/data/backups/pre-nanoid-20260914.sqlite`

The backup is readable only by its owner and passed `PRAGMA integrity_check`. The live database also passed integrity checking and had zero foreign-key violations after the production journeys.

All pre-release UUID records remained present: 8 users, 9 organizations, 13 memberships, 95 sources, 129 execution plans, 129 jobs, 309 artifacts, 6 saved videos, and 11 storage transfers. Changes and cleanup were confined to Densio.

## Checks

| Check                                       | Result                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node 22.18.0, Corepack pnpm 11.7.0          | Passed; portable Node archive checked against the official SHA-256 manifest                            |
| `pnpm install --frozen-lockfile`            | Passed                                                                                                 |
| `pnpm format`, then formatting verification | Passed; only the new test required formatting                                                          |
| `pnpm check`                                | All tests and typechecks passed; repository lint failed on the existing website errors described below |
| `pnpm lint:cli-release`                     | Passed with unchanged root lint rules                                                                  |
| Tests                                       | 1,217 passed: API 777, CLI 209, shared 160, emails 10, website 31, end-to-end 30                       |
| `pnpm build`                                | All five build tasks passed                                                                            |
| Docker production image build               | Passed on the production host; read-only host FFmpeg mount preserved                                   |
| `scripts/publish-cli.sh --dry-run`          | Passed tests, typechecks, formatting, builds, package allowlist and isolated installation              |
| `scripts/publish-cli.sh`                    | Passed and published 0.2.1                                                                             |
| Registry installation                       | Passed using a disposable directory and cache; executable used for production verification             |
| Production health and logs                  | Healthy; no application error or warning log entries during verification                               |

Tests used local substitutes and local FFmpeg. Production journeys were separate, explicitly authorized manual checks, not routine execution of the synthetic deployment scripts.

## Production journeys

| Area              | Evidence                                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy login      | Real Gmail confirmation for `lnikell+1@gmail.com`; user ID `36aabf19-eeae-403b-834e-b7f9265d184a` and default organization remained unchanged. A challenge started before rollout completed successfully.                                                                |
| Legacy media      | Existing UUID video `681d28d4-ebd4-4173-b860-c64c2997ed79` remained ready; stored variants downloaded with byte-count and SHA-256 verification.                                                                                                                          |
| New account       | Gmail confirmation provisioned `lnikell+5@gmail.com`, user `TsHqo879qm1eseqBLUXpm`, organization `ZmF0Xi2134XA`, with the expected Nano ID lengths.                                                                                                                      |
| Organizations     | Renamed the new organization. The legacy UUID user separately created a 12-character-ID organization; retry returned the same organization. The disposable organization was then closed.                                                                                 |
| Mixed memberships | A new Nano ID user invited a UUID user into the new organization; the UUID owner invited the Nano ID user into the legacy organization. Both invitations and acceptances succeeded with 21-character invitation/membership IDs. Test memberships were removed afterward. |
| ID boundaries     | Lowercased organization/source IDs were rejected. Reading the new source from another organization returned `SOURCE_NOT_FOUND`.                                                                                                                                          |
| Previous CLI      | A fresh `densio@0.2.0` installation successfully read a Nano ID source in a Nano ID organization from the deployed API.                                                                                                                                                  |
| Upload            | Uploaded a generated three-second 640×360, 24 fps video with audio. Source `8y4gnWrxxnYOVQt35xcF6` passed inspection; exact retry reused it.                                                                                                                             |
| Free processing   | Job `3MHxkxJ5XVjjN8CLl8Wl0` produced VP9/Opus and H.265/AAC. Independent FFprobe, byte-count and SHA-256 checks passed. Plan, job and artifact IDs had 21 characters.                                                                                                    |
| Billing guards    | Free AV1 planning returned `PLAN_ENTITLEMENT_REQUIRED`. Retrying the successful free job preserved its ID and single 0.05-credit charge; zero credits remained reserved.                                                                                                 |
| Stripe            | Confirmed sandbox mode. Hosted Basic checkout with the authorized 4242 card succeeded for the Nano ID organization. The webhook activated Basic and raised the allowance to 750 credits without resetting prior usage.                                                   |
| Managed storage   | Basic AV1 job `JRnZDfhlCw9kICGuGQEff` encoded 10-bit AV1/Opus, stored it in R2, and produced ready video `hSbnSSN2HXZ6UAoBaeHrI` and transfer `KoX9CmU7KeH4QYHCX10vz`. Verified downloads and embed generation passed.                                                   |
| Public playback   | Browser playback of the public AV1 URL reached its 3.016-second end with `readyState=4` and no media error.                                                                                                                                                              |
| Managed retry     | Retrying the managed job reused its original ID. Final new-organization usage was 0.10 credits, 749.90 available and zero reserved.                                                                                                                                      |
| Runtime skill     | Published CLI reported version 0.2.1 and loaded version-pinned references describing case-sensitive IDs and plan upgrades without a local FFmpeg fallback.                                                                                                               |
| Logout            | Both temporary CLI sessions were revoked and their credential files removed.                                                                                                                                                                                             |

The runtime skill version was `sha256:3814208b4f7166807f0f1e9ea79f917f373d1c50c787bab1ed5ef6c78a6f8e2c`.

## Findings and remaining limitations

### CLI publication blocked by independent website lint

The unchanged checkout failed repository lint before any release edits: 12 `max-lines-per-function` errors in website components and MDX plugins. The release script previously used this global lint command, preventing CLI publication even though the API, CLI and shared code passed.

Added `lint:cli-release` covering `apps/api`, `apps/cli`, `packages`, `e2e` and `scripts`, and made publication use it. No lint rule was relaxed. All-workspace tests, typechecks, formatting and builds remain mandatory, and root `pnpm check` still reports website errors. Six regression cases exercise the real linter: an independent website violation does not block publication, while the API, CLI, shared package, end-to-end harness and release tooling each retain the function limit. The website-isolation case failed before the change and passed afterward.

The existing website errors remain in `remark-steps.mjs`, `remark-image.mjs`, `remark-image.ts`, `snap-slider.tsx`, `search-dialog.tsx`, `social-share.tsx`, `get-components.tsx`, `video.tsx` and `heading.tsx`. They were not expanded into unrelated website refactoring during this ID release.

### Registry propagation

npm accepted publication before the new version was readable everywhere. Initial verification installs returned `ETARGET`; after propagation, a fresh online lookup and install succeeded. No duplicate publication was attempted.

### Deployment invocation

An initial invocation with an abbreviated commit hash could not be fetched by the deployment script. The running service was unaffected. Deployment succeeded with the complete commit SHA shown above.

### Sandbox subscription cleanup

The new test subscription is scheduled to end on October 14, 2026. Both the hosted portal and a read-only Stripe retrieval confirmed the schedule. Stripe represented it using `cancel_at`, with `cancel_at_period_end=false`; Densio stored the webhook's matching boolean. The existing billing response exposes a period date as `renewsAt` and does not expose this explicit cancellation timestamp. Cancellation was therefore verified directly with Stripe, rather than inferred from that date. This existing response limitation was not changed by the ID release.

The legacy test organization's Basic subscription and balances were unchanged. The new alias, its organization and small saved verification video remain available for inspection. Temporary memberships were removed. Closure was requested for the disposable extra organization `GM4qKRBj37cm`; its last observed state was `deleting`.

### Existing UUID visible in the user's command

The user subsequently showed `npx --yes densio@0.2.1 --org 3bd9072b-ca42-4bc2-a583-8eea741ce310 ...`. A read-only production lookup identified this as **Toolcraft**, created on September 14 at 12:02 UTC (14:02 Paris), before the deployment at approximately 17:31 UTC (19:31 Paris). The CLI is receiving an explicit persisted organization ID; it is not generating that UUID.

The source change replaces generation for new records and does not migrate existing IDs. Nine pre-release organizations therefore still have UUIDs. Removing those existing UUIDs is a separate data operation: either migrate IDs and their database, billing, storage and credential references, or reset Densio test data. The user's data-handling preference was requested before starting that operation.
