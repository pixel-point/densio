# Densio managed video storage

This module provisions three R2 buckets per environment, a public custom domain,
public read CORS, disabled r2.dev access, two-day staging expiry, and two-day
multipart abortion in every bucket. Final public/private objects have no expiry.
Buckets reject accidental Terraform destruction. Production and staging require
separate state files/backends and credentials.

Provider schema: [Cloudflare R2 Terraform resources](https://developers.cloudflare.com/api/terraform/resources/r2/).
Provider is pinned to [5.24.0](https://github.com/cloudflare/terraform-provider-cloudflare/releases/tag/v5.24.0).

1. Configure a protected remote Terraform state backend with locking. Supply
   `CLOUDFLARE_API_TOKEN` through your secret manager. Use a provisioning token
   scoped to the relevant account and zone; do not reuse it in Densio.
2. Copy `example.tfvars` to your environment input and substitute your account,
   zone, environment, and domain. `media.densio.sh` is the production hostname.
3. Run `terraform init`, `terraform validate`, and
   `terraform plan -var-file=ENVIRONMENT.tfvars -out=storage.tfplan`.
4. Review that only the public bucket gets a custom domain. Review the lifecycle
   diff carefully: deletion belongs only on staging. Apply the reviewed plan as
   an explicit deployment action.
5. Create an R2 S3 access key scoped to these three buckets with object read/write,
   list multipart, multipart upload, copy, abort, and delete permissions. Create a
   separate Cloudflare token with cache-purge permission for the media zone.
6. Configure the runtime secret described below and restart Densio. Before launch,
   certify multipart copy, range reads, anonymous private denial, public cache
   headers, and public withdrawal plus purge against the actual R2 account.

Terraform does not issue runtime S3 keys or encryption keys. Runtime secrets must
not appear in Terraform outputs, source control, command arguments, or logs.

## Runtime configuration

Supply `STORAGE_CONFIG_JSON` from a secret manager. An omitted value disables
managed storage and connection creation; ordinary temporary compression works.
The JSON shape is:

```json
{
  "activeCredentialKey": "primary",
  "credentialKeys": { "primary": "REPLACE_WITH_64_HEXADECIMAL_CHARACTERS" },
  "activeManagedTarget": "production",
  "managedTargets": [
    {
      "name": "production",
      "endpoint": "https://ACCOUNT_ID.r2.cloudflarestorage.com",
      "publicBucket": "densio-prod-media-public",
      "privateBucket": "densio-prod-media-private",
      "stagingBucket": "densio-prod-media-staging",
      "publicOrigin": "https://media.densio.sh",
      "zoneId": "REPLACE_WITH_32_CHARACTER_ZONE_ID",
      "purgeToken": "REPLACE_WITH_ZONE_PURGE_TOKEN",
      "credentials": {
        "accessKeyId": "REPLACE_WITH_R2_ACCESS_KEY_ID",
        "secretAccessKey": "REPLACE_WITH_R2_SECRET_ACCESS_KEY"
      }
    }
  ]
}
```

Generate a random 32-byte encryption key with your secret manager. Customer keys
are encrypted with AES-256-GCM and bound to organization, connection and credential
version. Keep previous encryption keys configured while any connection or pending
rotation references them. Back up key versions separately from SQLite.

The physical target identity hashes endpoint, buckets, public origin and zone.
Rotating runtime S3 credentials preserves it. If changing physical storage, add a
new named target and retain every old target in `managedTargets` until its objects
have been deliberately migrated or deleted. Changing `activeManagedTarget` affects
new plans. Never rename buckets underneath existing records.

## Delivery and recovery

Public keys are `orgs/ORG_ID/videos/VIDEO_ID/homepage-hero-vp9.webm` (and the selected
H.265/AV1 files). Private replacements have unique `copies/COPY_ID` paths. Display
renames preserve filenames and URLs. Staging contains transfer/attempt IDs only.
R2 must serve the stored `Content-Type`, inline disposition and cache control:
`public, max-age=60, s-maxage=86400, must-revalidate`. Do not override browser TTL
above 60 seconds or enable serving stale content on the media hostname. Densio
waits for origin deletion, successful URL purge, and the 60-second freshness bound
before completing public withdrawal. Clients can retain files already downloaded.

Storage reservations remain charged through partial-transfer cleanup. A retry
continues the recorded multipart sessions and the original recovery deadline.
Never manually clear a worker PID or change an object key to bypass uncertainty.
Check process identity, stop/drain the actual writer, and inspect the exact recorded
bucket/key/upload ID before reconciliation. Provider errors may require restoring
credentials or permissions; successful requests do not prove every alias is private.

Back up SQLite with its WAL using a consistent snapshot. Restore it together with
matching encryption keys, physical target configuration, and object inventory.
After a restore, pause new storage admissions and audit remote objects and multipart
sessions against `storage_objects`. Quarantine unknown objects for operator review;
do not delete them based solely on an older database snapshot.

Monitor blocked transfers, oldest retry age, staging objects near two days, quota
reservations, pending public purges, connection cleanup obligations, and failed
retention email deliveries. A source upload uses private customer staging; a public
R2 connection must provide a different private staging bucket. Completed customer
objects survive disconnect and organization closure. Disconnection erases all
credential copies and returns exact remaining cleanup obligations.

No real account has been provisioned by adding this module. Apply and account
certification are separate deployment steps requiring environment credentials.
