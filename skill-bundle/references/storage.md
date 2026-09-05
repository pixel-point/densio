# Storage and video delivery

Read this for durable hosting, storage connections, and public or private video delivery.

## Store and publish optimized video

Compression artifacts are temporary. Saving creates durable storage intent and keeps its recovery deadline even if a provider is unavailable. Public is the default visibility. `densio` is managed Densio R2 storage; any connection ID is customer-owned S3-compatible storage.

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json inspect input.mp4 --upload-storage CONNECTION_ID --idempotency-key upload-123
npx --yes densio@CLI_VERSION --org ORG_ID --json plans create SOURCE_ID compress --destination densio --name Homepage-Hero --visibility public
npx --yes densio@CLI_VERSION --org ORG_ID --json plans execute PLAN_ID --idempotency-key encode-123 --until stored
npx --yes densio@CLI_VERSION --org ORG_ID --json videos save JOB_ID --destination densio --name Homepage-Hero --visibility public --idempotency-key save-123
npx --yes densio@CLI_VERSION --org ORG_ID --json videos list --state ready --limit 25
npx --yes densio@CLI_VERSION --org ORG_ID --json videos get VIDEO_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json videos embed VIDEO_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json videos rename VIDEO_ID Homepage-Hero
npx --yes densio@CLI_VERSION --org ORG_ID --json videos visibility VIDEO_ID private --idempotency-key private-123
npx --yes densio@CLI_VERSION --org ORG_ID --json videos export VIDEO_ID --destination CONNECTION_ID --visibility public --idempotency-key export-123
npx --yes densio@CLI_VERSION --org ORG_ID --json videos download VIDEO_ID --output-dir ./public/video
npx --yes densio@CLI_VERSION --org ORG_ID --json videos retry VIDEO_ID --idempotency-key retry-123
npx --yes densio@CLI_VERSION --org ORG_ID --json videos cancel VIDEO_ID --idempotency-key cancel-123
npx --yes densio@CLI_VERSION --org ORG_ID --json videos delete VIDEO_ID --idempotency-key delete-123
npx --yes densio@CLI_VERSION --org ORG_ID --json videos forget VIDEO_ID --idempotency-key forget-123
```

Managed public URLs use `orgs/ORG_ID/videos/VIDEO_ID/NAME-CODEC.EXT`, such as `homepage-hero-vp9.webm`. Display renames preserve these immutable URLs. A public-to-private change removes public objects, purges Densio CDN delivery, waits through the browser freshness interval, and then reports ready. Explicit republishing of the same video restores the same URL with verified identical bytes.

Private downloads and every customer-storage download use a fresh, membership-bound grant per variant. The CLI verifies exact bytes and SHA-256 before publishing each local file. Customer objects remain in the customer's bucket after `videos forget` or `storage disconnect`; `videos delete --delete-objects` explicitly authorizes their removal.

## Configure S3-compatible storage

Keep credentials in an owner-only file (`chmod 600`) or pipe JSON through stdin. Configuration includes `config.location`, optional private `config.staging`, and `credentials`; public output also requires `config.publicBaseUrl`. Direct source uploads require private staging.

```sh
npx --yes densio@CLI_VERSION --org ORG_ID --json storage connect --name Website --config ./storage.json --idempotency-key connect-123
npx --yes densio@CLI_VERSION --org ORG_ID --json storage list
npx --yes densio@CLI_VERSION --org ORG_ID --json storage get CONNECTION_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json storage test CONNECTION_ID --idempotency-key test-123
npx --yes densio@CLI_VERSION --org ORG_ID --json storage rotate CONNECTION_ID --config ./new-credentials.json --idempotency-key rotate-123
npx --yes densio@CLI_VERSION --org ORG_ID --json storage disable CONNECTION_ID --idempotency-key disable-123
npx --yes densio@CLI_VERSION --org ORG_ID --json storage disconnect CONNECTION_ID --idempotency-key disconnect-123
npx --yes densio@CLI_VERSION --org ORG_ID --json storage operation OPERATION_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json storage default densio --visibility public
npx --yes densio@CLI_VERSION --org ORG_ID --json storage settings
npx --yes densio@CLI_VERSION --org ORG_ID --json storage usage
npx --yes densio@CLI_VERSION --org ORG_ID --json storage transfer TRANSFER_ID
npx --yes densio@CLI_VERSION --org ORG_ID --json storage retry TRANSFER_ID --idempotency-key retry-transfer-123
npx --yes densio@CLI_VERSION --org ORG_ID --json storage cancel TRANSFER_ID --idempotency-key cancel-transfer-123
```

Connection validation checks multipart create, upload, completion, exact readback, unfinished-upload abort, deletion, and public/private delivery before activation. Disconnect disables new work immediately, drains active writers, erases every stored credential version, retains completed customer objects, and returns exact unresolved bucket/key/upload obligations if cleanup cannot be confirmed.
