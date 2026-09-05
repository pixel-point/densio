# End-to-end verification

The golden E2E test exercises the application as a user-visible system while replacing only the two
external network boundaries: email delivery and Stripe API calls.

Run it directly with:

```sh
pnpm test:e2e
```

It requires FFmpeg and FFprobe with `libsvtav1`, `libvpx-vp9`, and `libx265`. The command builds the
workspace before running the test so the CLI process uses its production bundle.

## Golden journey

The test starts the same scoped application lifecycle used by production with a temporary SQLite
database and media root. It then:

1. loads the small runtime skill anonymously and executes its documented sign-in commands with fresh credentials;
2. captures the rendered outbox email and opens its one-time confirmation URL;
3. executes the skill's documented default compression on the automatically created Free organization, verifies both local outputs and the original input, loads a version-matched reference, and then requests a Basic Stripe Checkout session;
4. sends correctly signed checkout and subscription webhook events through the real webhook parser;
5. verifies the default organization has Basic while separately registered users' organizations stay Free;
6. uploads the committed tiny video once as a prepared source and verifies trusted inspection;
7. lists that source, compares VP9/H.265 on one shared sample with SSIM/PSNR, and extracts images from the same upload;
8. creates an immutable paid-only AV1 plan with an exact credit quote and intent digest;
9. executes the plan with that exact credit guard, an idempotency key, and a client reference;
10. retries execution safely and recovers the same job by its client reference;
11. watches sequence-deduplicated job events through terminal artifact publication;
12. authorizes artifacts per membership, tests private/no-store conditional and range downloads, removes/rejoins the creator, and proves old grants remain revoked while another member's grants survive;
13. materializes and verifies the artifact, relative HTML, and manifest through the built CLI;
14. verifies the local stream's codec and dimensions with FFprobe; and
15. deletes the remote artifacts and prepared source explicitly and verifies the successful job's receipt is unchanged.

## Skill onboarding acceptance

The golden journey extracts the first-use command examples from the actual served entrypoint and runs them through the built CLI. Only the `npx` package launcher is replaced with that local bundle; argument placeholders are supplied as process arguments, including an output directory containing spaces. It checks anonymous bootstrap, email-confirmed registration, automatic Free organization creation, default VP9/H.265 compression, verified local output, unchanged input, and loading one version-matched reference. CLI tests separately reject a changed bundle and malformed reference requests.

This is an executable documentation test. It does not measure whether a language model discovers the skill or follows its instructions. Before claiming support for an agent, also run a fresh-session acceptance check with no Densio conversation history, using a dedicated test account and fixture. Live acceptance checks are deliberate release checks, not part of the local suite.

Install only the public Densio skill and give the agent: “Use Densio to compress this video for my website and save the outputs here.” Pass when it obtains email confirmation on first use, uses one selected organization, pins the bootstrap CLI version, avoids loading unrelated references for default compression, and produces verified VP9/H.265 files and a correct result report without asking the user to learn CLI commands or configure an API key. Record the agent/version, CLI version, skill version, completion time, unnecessary questions, and any operator intervention.

Repeat in a signed-in session, with multiple organizations, with a requested 10-bit output, and after an interrupted wait. The agent must preserve explicit output preferences and recover the existing job. Do not count the scripted golden journey as a passed fresh-agent evaluation.

## Confidence boundary

The journey also verifies invitation acceptance through the delivered email's browser link and
confirmation form, CLI acceptance when rejoining, unchanged defaults, cross-organization
denial, shared organization credits, owner-only billing, and admitted work surviving creator removal.

This suite proves Densio's local orchestration, persistence, HTTP contracts, CLI behavior, webhook
handling, entitlement enforcement, prepared-source reuse, immutable planning and guards, idempotent
recovery, ordered events, worker lifecycle, media processing, independent authorization, verified
materialization, and explicit retention cleanup. It is deterministic and does not contact Stripe or
Resend.

Provider confidence remains a separate operational layer:

- staging runs the same user journey with Stripe test mode and a dedicated real mailbox;
- production runs auth, organization billing reads, and tiny compression in an explicitly selected paid organization;
- live Stripe purchases remain deliberate release checks rather than automated recurring
  transactions.

Do not add production `E2E_MODE` branches or test-only HTTP routes. New local provider behavior
belongs at the existing `EmailSender` or `StripeGateway` boundaries.

## Deployed synthetics

The deployed checks are ordinary scripts, not part of `pnpm test`, because they need provider
credentials and a reachable deployment. Both use the built CLI, wait for a real Densio login email
through the Gmail API, download the compressed artifact with SHA-256 verification, and inspect the
AV1 stream with FFprobe.

Use a dedicated Gmail mailbox. Create a Google OAuth client with the
`https://www.googleapis.com/auth/gmail.readonly` scope and store its refresh token in the scheduler's
secret store. Both commands need:

```text
DENSIO_SYNTHETIC_API_URL
DENSIO_SYNTHETIC_EMAIL
DENSIO_SYNTHETIC_GMAIL_CLIENT_ID
DENSIO_SYNTHETIC_GMAIL_CLIENT_SECRET
DENSIO_SYNTHETIC_GMAIL_REFRESH_TOKEN
```

### Staging

Staging additionally needs a Stripe test-mode key and the exact Basic price configured on the
staging API:

```text
DENSIO_SYNTHETIC_STRIPE_SECRET_KEY=sk_test_...
DENSIO_SYNTHETIC_STRIPE_BASIC_PRICE_ID=price_...
```

Run:

```sh
pnpm synthetic:staging
```

The runner uses a unique Gmail plus-address, verifies that Densio created a test Checkout session
with the expected quantity-one price and organization metadata, expires that test checkout,
creates and pays a Stripe test subscription on Densio's already-mapped customer, waits for the registered
webhook to grant Basic, and performs AV1 compression. It deletes the test customer afterward. A
live Stripe key is rejected before any mutation.

### Production

The production mailbox must already belong to a dedicated paid Densio organization. Declare its
explicit ID and the plan it is expected to retain:

```text
DENSIO_SYNTHETIC_EXPECTED_PLAN=basic
DENSIO_SYNTHETIC_ORG_ID=organization-id
```

Run:

```sh
pnpm synthetic:production
```

This verifies real email delivery and authentication, selects the requested organization, verifies
its existing paid entitlement, and completes real AV1 compression. It does not create a checkout,
change billing, supply payment details, or create a live charge.

Run staging after a staging deployment and production hourly. Configure the scheduler to prevent
overlapping runs and alert on a non-zero exit code. Each runner writes one JSON result to stdout or
one safe error message to stderr; credentials and login tokens are never emitted.
