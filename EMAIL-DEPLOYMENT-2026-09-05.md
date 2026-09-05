# Email deployment verification — 2026-09-05

## Spark dark-mode fix — verified

The user's Spark on Mac screenshot of the 22:12 message confirms that deployment
`ab8da66` did **not** resolve the reported appearance. That message was sent after
the deployment. Its white background and dark text both appear transformed into
a dark background and light text. This points to client color adjustment; it is
not evidence that the white background was absent from the delivered HTML.

Fix `3f0c495f5b23c4239132f43629314a76a56c86dd` adds `color-scheme: only light` to the document and canvas,
the legacy supported-color-schemes declaration, and scoped dark-mode rules for
white table backgrounds, dark text, blue links, and contrasting action buttons.
The [CSS Color Adjustment specification](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-prop)
defines `only` as the opt-out from automatic color-scheme overrides. The user
confirmed that the new preview works in Spark on Mac and authorized deployment.

- Three new regression cases failed before the candidate and passed afterward. All 1,158 tests, workspace typechecks, formatting, scoped lint, and the build passed under Node 22.18.0 / Corepack pnpm 11.7.0. Full `pnpm check` still fails on the 12 existing website lint errors below.
- With the browser reporting `prefers-color-scheme: dark`, all three candidate templates computed a white canvas and `#2C2B31` heading. The sign-in button and its nested text computed black background and white text, including WebKit text-fill color. Browser rendering is not a substitute for Spark validation.
- Sent **Densio — Spark white background preview** to `lnikell+1@gmail.com` at **22:35 Paris / 20:35 UTC**. Resend accepted message `b87407ca-4de2-4f8e-87dd-270a01525595`; it appeared in Gmail. The preview contains explanatory test copy and a public website link, with no login token or account operation.
- The user verified the 22:35 preview in Spark on Mac: "yep this fix worked". The second candidate resolves the reported background issue in the user's client.
- Deployed that exact verified source revision with `prime-server/bin/deploy densio 3f0c495f5b23c4239132f43629314a76a56c86dd`. The production image built successfully; the replacement became healthy before the old container stopped. `densio-api-17` is healthy with zero restarts, and public `/ready` returns HTTP 200.
- Confirmed the deployed API bundle contains the light-only declaration, dark-mode rules, canvas selectors, and button contrast rules. Database integrity remains `ok`; no migration or reset was performed. All 15 unrelated containers retained their IDs, and the FFmpeg mount remains read-only.
- Deployment evidence is `/private/tmp/densio-email-deployment-20260905/dark-deploy.log`, `dark-ready.json`, and `dark-containers-before.txt` / `dark-containers-after.txt`.
- Candidate validation logs are `/private/tmp/densio-email-deployment-20260905/dark-*.log`; the inert preview is `email-background-previews/spark-light-preview.html` in the same directory.

## First white-background attempt — insufficient in Spark

After the initial Gmail verification, the user reported a gray background in
Spark. The initial verification did not establish Spark compatibility.

Deployed fix `ab8da6643f9d35a6a7d09d810381c4d6365e8640`. All three templates now use
a shared `EmailBody` with an explicit `#FFFFFF` background on the full-width
presentation table and its cell, plus the table's legacy `bgcolor` fallback.
Previously, React Email's generated outer table was transparent: the body and
its cell carried white CSS, but the table itself had neither background CSS nor
a `bgcolor` attribute. This fixes that markup gap; it does not prove which Spark
processing or appearance setting caused the reported gray background.
The approach follows [Litmus's background-color testing](https://www.litmus.com/blog/background-colors-html-email).

- Added three regression cases covering sign-in, invitation, and storage messages. All three failed on the missing table background before the fix, then passed.
- Ran `pnpm format`, `pnpm check`, scoped lint, `pnpm format:check`, and `pnpm build` under Node 22.18.0 / Corepack pnpm 11.7.0 in isolated validation containers. All workspace typechecks and 1,155 tests passed. Build, formatting, and scoped lint passed. Full `pnpm check` still exits 1 on the same 12 pre-existing website lint errors documented below.
- Rendered the compiled email package with inert data. All three messages retained a full-width white canvas inside a gray host after stripping the document body and head, and again after also stripping every inline style. The latter verifies the HTML background fallback. These are controlled browser checks, not Spark emulation.
- The production Docker build and rollout succeeded. `densio-api-16` runs the exact fix revision, healthy with zero restarts; `/ready` returns HTTP 200. Densio database integrity is `ok`; all 15 unrelated containers retained their IDs. No data migration or reset was needed.
- A fresh sign-in email to `lnikell+1@gmail.com` reached `sent` on its first attempt with no last error. Gmail's rendered DOM confirmed the new outer table has `bgcolor="#FFFFFF"`, a computed white background, and `width="100%"`; earlier messages in the same thread retain their transparent outer tables.
- Clicking the new Continue button showed **Login confirmed** and authenticated the existing account with its original default organization. Verification used the previously downloaded published CLI 0.2.0 bundle directly after the local `npx` wrapper reported `densio: command not found`. The disposable session was revoked and its credential file removed.
- Spark is not available through this environment's Mac app controls. The user's later screenshot confirmed that this attempt remained dark in Spark; see the investigation above.
- Follow-up logs are `/private/tmp/densio-email-deployment-20260905/background-*.log`; inert previews are in the `email-background-previews` subdirectory. No secrets or signed links are included here.

## Initial deployment result

Pulled `main` to `3c39ebb42649760b9802cfc3e0d3bdf3b1b079c3` and deployed that exact
revision using `/Users/alex/Projects/prime-server/bin/deploy densio <SHA>`.
The redesigned emails rendered in Gmail and browser invitation acceptance worked
in production. The Spark background issue was reported afterward; subsequent
attempts and their limitations are recorded above.

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
