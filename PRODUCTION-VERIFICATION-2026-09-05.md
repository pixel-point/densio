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

| ID       | Finding                                                                                                                                                                       | Action / status                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PROD-001 | Organization migration refuses a nonempty legacy database. Production has three users, 53 terminal jobs, and one active test subscription. No jobs are running.               | Use the user-authorized Densio-only fresh database cutover with a recoverable backup. Verify a previously registered email can sign in again. Pending.             |
| PROD-002 | Local CLI source is version 0.1.3 while npm latest is 0.1.4; local npm publishing authentication is absent.                                                                   | Verify and prepare a new CLI release so the runtime skill can use the matching API. Pending.                                                                       |
| PROD-006 | Stripe test portal allows cancellation but disables plan updates.                                                                                                             | Enable updates for the configured Densio test prices before exercising a plan change. Pending.                                                                     |
| PROD-003 | Production has no `STORAGE_CONFIG_JSON`. Stripe test mode, active monthly USD prices (Basic $9 / Pro $29 / Scale $59), and the enabled Densio webhook were verified directly. | Determine which storage features need provisioning and test configured workflows. Pending.                                                                         |
| PROD-005 | The Mac ran out of disk space during temporary Node extraction.                                                                                                               | Removed only this run’s incomplete download. Moved validation to a disposable server container (8 CPUs, 12 GB limit).                                              |
| PROD-004 | Default local Node is 25.8.1 and Corepack is absent from PATH.                                                                                                                | Validation runs in an isolated Node 22.18.0 container with Corepack pnpm 11.7.0, no production credentials, a separate filesystem, and the read-only FFmpeg mount. |

## Verification ledger

| Check                                                    | Result                                                 |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Initial host health and unrelated container inventory    | Passed; Densio and all healthchecked services healthy. |
| Densio scope, database size, and active jobs             | Passed; read-only inspection, no active jobs.          |
| Frozen dependency installation                           | Pending.                                               |
| Root formatting and `pnpm check`                         | Pending.                                               |
| Workspace build and packaged CLI dry run                 | Pending.                                               |
| Production Docker image build                            | Pending.                                               |
| Densio backup and cutover                                | Pending.                                               |
| Existing email login                                     | Pending.                                               |
| Fresh alias registration and email delivery              | Pending.                                               |
| Default Free compression and downloaded media            | Pending.                                               |
| Stripe test checkout, webhook, plan change, portal       | Pending.                                               |
| Organization edit, invitations, roles and isolation      | Pending.                                               |
| Prepared sources, comparison, extraction, AV1, trim, HLS | Pending.                                               |
| Runtime skill version and references                     | Pending.                                               |
| Final health, logs, and unrelated container comparison   | Pending.                                               |

## Account compatibility

The new schema changes ownership from users to organizations and intentionally does
not migrate legacy account state. A fresh database means previous sessions must
sign in again; old jobs, usage history, and subscription mappings are not retained
in the active database. Previous data will remain in the protected Densio backup.
The prior email sign-in check and handling of the existing Stripe test subscription
must be completed before this release is considered verified.
