# Error and retry playbook

JSON problems include `code`, `retryable`, `suggestedAction`, `correlationId`, and sometimes `jobId`.

## Exit codes

| Exit | Meaning                 | Action                                                 |
| ---: | ----------------------- | ------------------------------------------------------ |
|    0 | Success                 | Parse the one stdout JSON document.                    |
|    2 | Usage                   | Correct flags; do not retry unchanged.                 |
|    3 | Authentication          | Run `auth login`, then retry once.                     |
|    4 | Plan, limit, or credits | Follow the suggested plan or credit action.            |
|    5 | Remote/media failure    | Follow the problem code and suggested action.          |
|    6 | Network or wait timeout | Resume/retry with the same job ID or idempotency key.  |
|  130 | Interrupted wait        | Follow `suggestedAction`; media jobs continue running. |

## Common codes

- `AUTH_REQUIRED`, `AUTH_CHALLENGE_EXPIRED`: complete or restart human email login.
- `CREDITS_EXHAUSTED`: the current UTC month's credits cannot cover the initial hold or the exact compression cost calculated after inspection. No encode was started and the job's reservation was released. Do not retry unchanged until credits reset, the requested work costs less, or the account moves to a plan with more credits.
- `DURATION_LIMIT_EXCEEDED`: shorten the source to the plan-specific maximum reported by `capabilities` (30 minutes on Free and 180 minutes on Basic, Pro, and Scale).
- `CODEC_NOT_ENTITLED`: refresh capabilities before choosing a codec. On Free, choose VP9 or H.265, or report that AV1 requires Basic or higher.
- `IDEMPOTENCY_CONFLICT`: the key belongs to a different request. Reuse the original request or create a new intentional key.
- `UPLOAD_TOO_LARGE`, `UPLOAD_SIZE_MISMATCH`: correct the source/request; do not loop.
- `JOB_STATE_CONFLICT`: fetch `jobs get JOB_ID` before deciding whether to wait, submit an outstanding frame-rate decision, cancel, or create another job. A frame-rate choice must resume the existing job.
- `MEDIA_PROCESS_FAILED` and deterministic media validation errors: inspect `suggestedAction`; do not blindly retry identical input and options.
- `CLI_WAIT_TIMEOUT`: resume the existing job. Do not create another.
- `CLI_INTERRUPTED`: follow `suggestedAction`. Resume when `jobId` is present; restart `auth login` when email confirmation was interrupted.
- `CLI_NETWORK_ERROR`: retry with bounded backoff. For creation, keep the same idempotency key.
- `ARTIFACT_HASH_MISMATCH`: the CLI discards the temporary result. Re-fetch `jobs get JOB_ID` to confirm the expected URL and digest. If the same link mismatches again, stop and report the correlation ID; reprocess only with user consent because v1 has no link-refresh endpoint.

Retry only when `retryable` is true or the failure is a client network interruption. Preserve `correlationId` when reporting an operator issue.
