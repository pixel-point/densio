# Email deployment verification — 2026-09-05

## Result

Pulled `main` to `3c39ebb42649760b9802cfc3e0d3bdf3b1b079c3` and deployed that exact
revision using `/Users/alex/Projects/prime-server/bin/deploy densio <SHA>`.
The redesigned emails and browser invitation acceptance work in production.
No application fixes were needed during this verification.

Production runs `densio-api-15`, image
`densio-api:3c39ebb42649760b9802cfc3e0d3bdf3b1b079c3`. Its final state was running,
healthy, with zero restarts; `https://api.densio.sh/ready` returned HTTP 200.
The existing Densio database was preserved and its integrity check returned `ok`.
All 15 unrelated running containers retained their original IDs.

## Validation

- Frozen dependency installation, all workspace typechecks, and 1,152 tests across 195 files passed under Node 22.18.0 / Corepack pnpm 11.7.0. Counts: shared 160, emails 4, CLI 199, API 762, deterministic end-to-end 27.
- API, CLI, shared/email packages, and end-to-end lint passed with zero warnings or errors. Root formatting verification and the full workspace build passed, including the new website build.
- The production Docker build passed with the new email workspace included. The rollout brought up the healthy replacement before stopping the old container. The read-only host FFmpeg mount remains intact.
- Full `pnpm check` reached lint after all tests/typechecks passed, then failed on the 12 website function-length errors listed below. It is not reported as an overall pass.
- Deterministic checks ran in disposable validation containers limited to eight CPUs and 12 GB RAM. They mounted an archived copy of the selected Git revision and read-only FFmpeg, with no production data or credentials. These tests did not contact production email, Stripe, or storage providers.

## Production email checks

| Check                    | Evidence                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing-account sign-in | `lnikell+1@gmail.com` received the new **Confirm your sign-in to Densio** message. Gmail showed the Densio wordmark, large heading, black Continue button, fallback URL, and company footer. Clicking Continue rendered **Login confirmed** and authenticated CLI 0.2.0 with its existing owner membership.                                            |
| Invitation rendering     | The invitation to `lnikell+3@gmail.com` rendered the organization name, **You're invited** heading, black Accept invitation button, fallback URL, and company footer in Gmail.                                                                                                                                                                         |
| Browser acceptance       | Opening the email link showed the correct address, organization, and member role. GET left the invitation pending and did not create membership. Submitting the button showed **Invitation accepted** and created the expected membership. Reloading safely retained the accepted result.                                                              |
| Invited-account login    | Alias +3 received its new sign-in email, clicked Continue, and authenticated successfully. It could read the existing ready managed video in the test organization. Its separate default Free organization remained selected.                                                                                                                          |
| Delivery health          | All three messages from this verification reached `sent` on the first attempt, with no last error.                                                                                                                                                                                                                                                     |
| Storage notice           | Rendered the compiled storage template with inert preview data and inspected it visually. It showed a readable UTC calendar date, recovery choices, deletion consequences, and footer. Rendering, real-policy reminder scheduling, stale-notice suppression, and provider-adapter tests passed. No false storage warning was sent to production users. |
| Session cleanup          | Both disposable CLI sessions were logged out and their credential files removed. Temporary browser tabs and the local preview server were closed.                                                                                                                                                                                                      |

## Findings outside the email deployment

### Local disk space

Local `pnpm install --frozen-lockfile` failed with `ERR_PNPM_ENOSPC`; available disk
space was approximately 0–260 MiB during the attempt. This also interrupted the
browser helper temporarily. Removed only this task's old temporary Node 22
distribution, then restored browser access and completed validation on the server.
The local dependency installation did not complete and needs a retry after disk
space is freed. No unrelated user files or shared package caches were removed.

### Website lint errors in the pulled revision

The root 100-line function limit rejects these locations in `apps/website`:

| File                                                 | Function lines reported | Error count |
| ---------------------------------------------------- | ----------------------- | ----------- |
| `src/components/content/heading.tsx:38`              | 103                     | 1           |
| `src/components/content/video.tsx:51`                | 128                     | 1           |
| `src/components/content/get-components.tsx:62`       | 237                     | 1           |
| `src/components/ui/search-dialog.tsx:209`            | 213                     | 1           |
| `src/components/ui/snap-slider.tsx:35`               | 153                     | 1           |
| `src/components/pages/blog/post/social-share.tsx:59` | 104                     | 1           |
| `src/lib/mdx-plugins/remark-image.mjs:13`            | 112 / 106               | 2           |
| `src/lib/mdx-plugins/remark-image.ts:49`             | 138 / 132               | 2           |
| `src/lib/mdx-plugins/remark-steps.mjs:6`             | 115 / 113               | 2           |

Root lint also reported 23 website warnings. These failures were reproduced on
the unmodified pulled revision; no rules were weakened or disabled. They do not
affect the deployed API/email image. The existing deployment configuration rolls
out the API service; the new website was built for validation but was not added
as a new hosted service by this deployment.

## Retained test state and evidence

- Invitation `e7091c33-4e97-4a77-a56a-46ced9cf2c61` is accepted in **Densio production verification** (`c2dc09c3-dc06-42e2-b2dd-a88d28b0e776`).
- Alias +3 user `cef6e07f-4094-490a-b2d9-27d5eb676ecf` retains member access there and owns its automatically provisioned default organization `79855bad-d209-4ec5-a4ad-bbed678310d5`.
- Existing owners, admins, media, billing, and database history were retained. This verification did not create a media job or charge credits.
- Local non-secret logs and the inert storage preview are under `/private/tmp/densio-email-deployment-20260905`. Validation logs also remain under `/home/primeui/apps/densio/validation/email-release-20260905.*.log` on the server.
- Tokens, signed email links, production environment values, and credential contents are excluded from this report.
