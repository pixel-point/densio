import { renderCommandHelp } from "./command-catalog.ts";

export const CLI_HELP = `densio — agent-first video processing

Usage:
  densio [--api-url URL] [--org ORG_ID] [--json] <command>

Workflow:
  inspect VIDEO → jobs create SOURCE_ID WORKFLOW → artifacts materialize JOB_ID
  Sources are reusable uploads. Plans are immutable; resolving a decision creates a child plan.
  Direct submission resolves intent and reserves credits atomically; plans are optional previews. Deleting a source does not delete attached job inputs.

Global options:
  --api-url URL       API URL (DENSIO_API_URL; default: https://api.densio.sh)
  --credentials PATH  Override the owner-only credential file
  --org ORG_ID        Pin organization for the entire command (overrides DENSIO_ORG_ID, local selection, server default)
  --json              One success document on stdout; problems and event JSONL on stderr

Commands:
${renderCommandHelp()}

Agent behavior:
  skill returns only SKILL.md by default. Load skill PATH --skill-version VERSION for an on-demand reference.
  Pin npx --yes densio@CLI_VERSION to the returned cliVersion throughout the workflow.
  Choose and disclose the organization before spending credits or deleting shared resources.
  Organizations own uploads, plans, jobs, artifacts, subscriptions, and pooled monthly usage; pricing is not per seat.
  orgs use changes local selection only; orgs default changes the server default only. Creating or joining changes neither.
  Positional organization IDs override environment/local selection; a conflicting --org is an error.
  capabilities --public is anonymous. Other media and billing commands require authentication and an organization.
  jobs create and plans execute wait by default and reports the resumable job ID on stderr immediately.
  --no-wait returns that ID without waiting. Interrupted or timed-out waits do not cancel jobs.
  jobs wait and jobs watch consume ordered events and confirm completion with authoritative status.
  Job receipts preserve execution facts; live artifact availability is separate from temporary access grants.
  Credential refresh preserves the command's verified user and organization; account changes fail closed.
  Retry uncertain checkout with the same key and contact changes with the same email; persistent billing uncertainty needs a platform operator.
  Deletion revokes access immediately; physical cleanup waits for active writers. Organization cleanup completes at state deleted.
  Trimming uses zero-based source frames with an inclusive start and exclusive end; omitted end means video EOF.
  Standalone trim re-encodes one chosen codec and preserves cadence with even-dimension normalization; compression trims before transforms.
  Output-byte limits are checked after encoding: completed encoding work is charged even when oversized.
  Compression and quality comparison default to 8-bit. Use --bit-depth 10 when requested, keeping comparison and final compression at the same depth.

Examples:
  densio orgs list --json
  densio --org ORG_ID capabilities --json
  densio --org ORG_ID inspect input.mp4 --idempotency-key source-1 --json
  densio --org ORG_ID sources list --state ready --json
  densio --org ORG_ID jobs create SOURCE_ID compress --codec vp9 --idempotency-key compress-1 --json
  densio --org ORG_ID jobs create SOURCE_ID compare-quality --matrix vp9:36,42 --matrix h265:26,30 --samples 3 --idempotency-key compare-1 --json
  densio --org ORG_ID jobs create SOURCE_ID hls --destination densio --idempotency-key hls-1 --until stored --json
  densio --org ORG_ID plans execute PLAN_ID --idempotency-key execution-1 --no-wait --json
  densio --org ORG_ID jobs wait JOB_ID --output-dir public/media --json
`;
