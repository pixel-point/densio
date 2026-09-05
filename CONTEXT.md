# Domain and ownership map

Densio accepts media intent, resolves server policy, executes an immutable plan and publishes verified output. The usual client flow is source creation/upload, `jobs create`, then waiting and materialization. Explicit execution plans are optional previews.

| Concept           | Meaning                                                                           | Owner                                                                         |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Organization      | Authorization, billing, quota and media ownership boundary                        | `apps/api/src/organizations`                                                  |
| Subscription plan | Free/Basic/Pro/Scale entitlements; internal job field `subscriptionPlan`          | `auth`, `billing`, shared plan metadata                                       |
| Execution plan    | Immutable source snapshot, resolved intent and exact credit quote                 | `execution-plans`                                                             |
| Prepared source   | Reusable inspected input with its own retention deadline                          | `sources`                                                                     |
| Source ingestion  | Coordinates prepared source, multipart session and object admission/lifecycle     | `sources/source-ingestion-state.ts`; provider operations in `storage/uploads` |
| Job               | One admitted execution with attempts, leases and an immutable receipt             | `jobs/job-admission-service.ts`, worker and transition repository             |
| Artifact          | Verified temporary job output with independent access and retention               | `artifacts`, artifact publication                                             |
| Video             | Durable saved media, delivery visibility and display metadata                     | `videos`                                                                      |
| Storage object    | Physical bytes at one target/bucket/key/version                                   | `storage/objects`, transfer object repository                                 |
| Storage transfer  | Recoverable save/export/visibility/delete intent; may outlive its originating job | `storage/transfers`                                                           |

The public job summary retains the wire field `plan` for subscription compatibility; internal code uses `subscriptionPlan`. Creator identity is audit metadata. Authorization and cleanup follow organization ownership and durable writer evidence.

## Boundaries

HTTP handlers translate shared contracts into Effect operations and sanitize public failures. The API owns inspection, codec policy, entitlements, credit accounting and cleanup. CLI commands own input validation, authenticated transport, waiting and local output publication. `packages/shared` exports wire schemas and shared media/plan policy through `@densio/shared`. Applications do not import one another; only `e2e` composes them. The workspace-boundary test enforces these source import rules.

Workflow handlers retain their specific analysis types. A prepared execution closure carries that analysis to processing; the worker manages leases, quote comparison and state transitions. Persisted options/results and current job/attempt identity are still validated.

Connection validation, source ingestion, video transfers, source preparation, job admission recovery and organization cleanup each have their own supervisor. Failed iterations are logged and retried. `/ready` fails while a supervised loop reports a failure or has stopped; its public response does not expose provider or filesystem details. `lastSuccessAt` and failure counts are available on supervisor status for internal diagnostics. In-flight work has no generic duration threshold because legitimate media operations vary in length.

## Uncertain multipart recovery

Run against the affected deployment's configured database and providers:

```sh
pnpm --filter @densio/api admin storage inspect ORG_ID
pnpm --filter @densio/api admin storage reconcile ORG_ID OBJECT_ID
```

Inspection reads durable `creating` objects without a stored upload ID. Reconciliation reads provider HEAD and multipart inventory, then atomically checks an ownership snapshot before adopting exactly one matching upload ID. It checks every transfer for the video, source session and connection operation, including newer deletion work. An expired lease alone never proves a process exited.

The JSON result includes operator identity, observation time, a snapshot digest, safe inventory facts and the outcome. Retain that output in the operator's incident record. Unresolved objects keep their existing durable state; reconciliation does not create, complete, abort or remove provider objects, reset recovery deadlines, or override a cancellation. Empty or ambiguous inventory needs provider investigation. An existing object goes through normal byte/hash verification before publication. Recovery is restricted to multipart sessions; a failed small-object PUT is never retried by this tool.
