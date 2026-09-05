# Organization context and shared billing

Read this before selecting a workspace, changing membership/billing, or closing an organization.

## Select and pin

First confirmed registration creates an ordinary “My organization” owned by that user. Logging in again does not create another. Users may belong to multiple organizations; creating or accepting one does not change their default.

Discover memberships with `orgs list`. Selection is `--org ORG_ID`, then `DENSIO_ORG_ID`, then saved local context, then the authenticated user's server default. Invalid, removed, or closing selections fail; never silently fall back. Positional IDs on organization commands override environment/local defaults; a conflicting explicit `--org` is an error.

Disclose the selected organization name/ID and pin `--org ORG_ID` across the entire inspect → plan → execute → observe → materialize flow. Retain it alongside every source/plan/job ID and retry key. A command pins once, including credential refresh and retries. Never switch organizations to work around insufficient credits or missing resources.

`orgs use ORG_ID` saves local context only. `orgs default ORG_ID` changes the user's server default only. Local context is bound to API origin and verified user ID and survives token refresh. Neither selection transfers media, credits, or subscriptions.

`capabilities --public` is anonymous common policy, not the selected organization's entitlement. Use scoped `capabilities` and `billing status` before planning/spending.

## Roles and membership

Every member can inspect, process, download, cancel, and delete organization media and spend its shared credits. Resources remain with the organization when their creator leaves; creator IDs are audit provenance, not private ownership.

Owners and admins can rename the organization, invite/remove ordinary members, and read audit events. Only owners can grant/manage admins, change billing, transfer ownership, or close the organization. The one owner cannot leave, be removed, or change role through the generic member operation. Transfer to an existing member first; the previous owner becomes admin.

Invitations address verified email identities and expire after seven days. Repeating a pending invitation with the same role neither sends another email nor extends expiry; a changed role conflicts. Acceptance does not change defaults. A removed membership cannot be restored by replaying its accepted invitation. Demotion/removal revokes invitations the inviter can no longer grant.

Recipients accept in the browser using the signed invitation link in their email, then press **Accept invitation** on the confirmation page. Opening the link does not accept the invitation. The link verifies only the invited email and membership; it does not issue a general Densio session. New recipients register on acceptance using the normal “My organization” default. Existing recipients keep their defaults. Treat the link as a credential: never ask recipients to paste the email link into chat or print it in command output. The authenticated `invitations accept INVITATION_ID` command remains available for automation using the invited account; an invitation ID alone cannot authorize acceptance.

Removing a member revokes grants minted by that membership, not other members' grants. Rejoining creates a fresh membership; old download URLs remain invalid. Already-admitted jobs continue and settle against their original organization, even after creator removal or a month boundary.

If an offboarded/closing organization was a user's default, the server selects their earliest remaining active membership, or provisions an empty ordinary organization. It never transfers the old organization's resources or credits.

## Organization billing

Pricing is global usage per organization, never seats: Free 30, Basic 750, Pro 5,000, Scale 7,500 credits per UTC month. Adding members does not multiply allowances. Each organization has its own billing contact, Stripe customer, subscription, and ledger. Billing email is independent of the owner's login email.

Subscription checkout requires an owner and a stable `--idempotency-key`. Preserve that key after an ambiguous response. Retry identical intent with bounded backoff; do not try another key to bypass `ORGANIZATION_BILLING_BUSY`. The server reconciles provider evidence and prohibits multiple live/unresolved checkouts. A local lease timeout is not proof that Stripe created nothing.

Completed checkout remains unresolved until its subscription evidence commits. An uncertain checkout beyond the safe provider retry window needs a platform operator: `api-admin billing inspect ORG_ID` shows the saved intent, and `api-admin billing reconcile ORG_ID` reconciles existing provider evidence without creating a replacement checkout. These are local server commands, not end-user CLI commands. Ask the authorized operator; do not edit billing rows or invent a new payment key. Missing evidence leaves the operation blocked for provider investigation.

Contact recovery reuses the saved normalized billing email, including after 24 hours or an ownership transfer. Retry the same authorized `billing contact EMAIL` action; an operator can recover its persisted intent if the original caller is unavailable. A failed portal-session request does not leave a durable financial lock. Neither recovery path changes the organization's plan.

Present hosted checkout/portal URLs only as intended command results. They are bearer secrets: do not log them or store them in project files. Checkout expiry comes from Stripe; portal URLs have no fabricated expiry. Do not claim a plan changed until scoped billing status confirms it.

Membership, invitation, billing-contact, subscription, ownership-transfer, and organization-deletion mutations require authorization for those actions; ordinary media processing does not authorize them.

## Close an organization

Only an owner may run `orgs delete ORG_ID --confirm ORG_ID`. Confirm the exact organization and consequences within the user's authorization. Blocking work includes nonterminal jobs, pending/active uploads (including deleted sources with still-running writers), subscriptions that are not terminal, open/unresolved checkouts, and unresolved billing operations. Cancel-at-period-end is not terminal. The command does not cancel subscriptions, abandon uncertain payments, or refund work.

After acceptance the organization becomes `deleting`, access and invitations are revoked, defaults are repaired, and durable cleanup removes source/output/scratch bytes. Poll `orgs get ORG_ID` until `deleted`; a retrying cleanup is not completion. Repeating the same deletion is safe. Former members can inspect retained closure status but cannot use other organization endpoints.

Historical receipts, audit/billing records, and tombstones remain; media bytes do not. There are no user-owned billing or unscoped media aliases.

## Identity, organization, and capabilities

```sh
npx --yes densio@CLI_VERSION --json capabilities --public
npx --yes densio@CLI_VERSION --org ORG_ID --json capabilities
npx --yes densio@CLI_VERSION --json auth status
npx --yes densio@CLI_VERSION --json auth login agent@example.com
npx --yes densio@CLI_VERSION --json auth logout
npx --yes densio@CLI_VERSION --org ORG_ID --json billing status
npx --yes densio@CLI_VERSION --org ORG_ID --json billing subscribe basic --idempotency-key checkout/basic
npx --yes densio@CLI_VERSION --org ORG_ID --json billing subscribe pro --idempotency-key checkout/pro
npx --yes densio@CLI_VERSION --org ORG_ID --json billing subscribe scale --idempotency-key checkout/scale
npx --yes densio@CLI_VERSION --org ORG_ID --json billing contact billing@example.com
npx --yes densio@CLI_VERSION --org ORG_ID --json billing portal
npx --yes densio@CLI_VERSION --json skill
```

Present returned billing URLs; do not claim a subscription changed until billing status confirms it.

Retry billing contact with the same authorized email. Persistent checkout uncertainty needs platform-operator reconciliation; see [organizations.md](organizations.md). Do not use a new checkout key or a different organization to bypass it.

## Organizations and invitations

```sh
npx --yes densio@CLI_VERSION --json orgs list --limit 25
npx --yes densio@CLI_VERSION --json orgs create Team --idempotency-key organization/team
npx --yes densio@CLI_VERSION --json orgs get ORG_ID
npx --yes densio@CLI_VERSION --json orgs rename ORG_ID New-name
npx --yes densio@CLI_VERSION --json orgs use ORG_ID
npx --yes densio@CLI_VERSION --json orgs default ORG_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs members list
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs members set-role USER_ID --role admin
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs members remove USER_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs invitations list --state pending
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs invitations create recipient@example.com --role member
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs invitations revoke INVITATION_ID
npx --yes densio@CLI_VERSION --json invitations list
npx --yes densio@CLI_VERSION --json invitations accept INVITATION_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs transfer-ownership USER_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs leave
npx --yes densio@CLI_VERSION --org ORG_ID --json orgs audit-events --after 0 --limit 100
npx --yes densio@CLI_VERSION --json orgs delete ORG_ID --confirm ORG_ID
```

Read [organizations.md](organizations.md) for roles, authorization, shared billing, and closure recovery. Select with `--org` > `DENSIO_ORG_ID` > local context > server default. Never fall back from an invalid selection. Keep the same organization throughout retries. `orgs use` changes local context; `orgs default` changes the server default; creating/joining does neither. Directory limits are 1–100 (default 25), audit defaults to 100 with exclusive `--after 0`.
