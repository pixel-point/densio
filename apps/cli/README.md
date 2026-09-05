# Densio

Densio is an agent-first CLI for video compression, image extraction, and
quality comparison and HLS packaging through the Densio API.

For agent-led setup, install the skill with `npx skills add pixel-point/densio --skill densio`, then ask your agent to compress a video. It handles first-use email confirmation and saves the output in your project. This requires a terminal-capable agent, Node.js 22.18 or later, npm/npx, and network access.

Run the CLI directly without a global installation:

```sh
npx --yes densio@latest --help
```

For agent instructions, run `npx --yes densio@latest --json skill`. The response contains one document, a reference index, `cliVersion`, and `skillVersion`. Pin that CLI version with `npx --yes densio@CLI_VERSION` for subsequent commands. Load a reference with `skill references/commands.md --skill-version SKILL_VERSION`; a changed bundle returns `SKILL_VERSION_CHANGED` instead of mixing instructions. The API still serves the full bundle; selection limits what the CLI exposes to the agent.

Use `npx densio --org ORG_ID --json capabilities` to inspect current codecs, limits, and defaults.
First sign in with `auth login EMAIL`, discover organizations using `orgs list`, and choose an `ORG_ID`.
All members share one organization allowance; billing is never per seat. `orgs use ORG_ID` saves
local selection; `orgs default ORG_ID` changes the server default. Selection uses `--org` >
`DENSIO_ORG_ID` > local selection > server default, with no fallback from invalid IDs.
`capabilities --public` discovers anonymous common policy only.
Upload once and submit with a stable retry key:

```sh
npx densio --org ORG_ID --json inspect input.mp4 --idempotency-key source/hero
npx densio --org ORG_ID --json jobs create SOURCE_ID compress --frame-rate cap-30 --idempotency-key execute/hero --max-credits 2 --output-dir ./video
```

The same source supports `compare-quality`, `extract-images`, and `hls` jobs. Use
`sources list|get|delete` to manage uploads and `jobs wait|watch` to resume work.
Artifacts are addressed by stable IDs; downloads verify byte counts and SHA-256.

Store a compression in Densio R2 or a connected S3-compatible service and embed it directly:

```sh
npx densio --org ORG_ID --json jobs create SOURCE_ID hls --destination densio --name Homepage-Hero --idempotency-key execute/hero --until stored
npx densio --org ORG_ID --json videos embed VIDEO_ID
```

Public is the default. Use `--visibility private` for membership-bound downloads. `storage connect` reads credentials from an owner-only JSON file, and `inspect --upload-storage CONNECTION_ID` sends source parts straight to private customer staging. `storage usage`, `videos list`, `videos export`, `videos visibility`, `videos retry`, and `videos delete` manage the durable lifecycle.

HLS produces HEVC Main10 SDR fMP4 VOD with shared AAC audio and up to three renditions, encoded once from the original. Omitted H.265 CRF uses the compression API default (currently 30); `--h265-crf` overrides it. Capped CRF is the default and may constrain difficult scenes; `--rate-control crf` removes bitrate ceilings. No H.264 fallback is added. Playback requires HEVC support; native Safari and compatible MSE players must be tested for your target devices.

Use `--options-file PATH` for a custom HLS ladder or any workflow's options JSON. Do not mix it with individual workflow flags. Temporary HLS materialization downloads `hls.zip`; `videos download VIDEO_ID --output-dir DIR` restores verified durable package files, including private packages after the temporary artifact expires.

Plans remain available as optional previews: `plans create SOURCE_ID hls`, then `plans execute PLAN_ID --idempotency-key KEY`. Direct high-frame-rate submissions can return `MEDIA_DECISION_REQUIRED`; resubmit with an explicit `--frame-rate` choice. All normal submissions wait by default; use `--no-wait` to detach.

Each command pins its verified user and organization through credential refresh and retries.
Keep the same checkout key after an uncertain response and the same email when retrying a
billing contact update. Persistent payment uncertainty needs platform-operator reconciliation,
not a replacement checkout. Deletion revokes access immediately; byte cleanup waits for active
writers and retries automatically. Organization closure is complete only at state `deleted`.

See the [Densio repository](https://github.com/pixel-point/densio) for
authentication, planning, cleanup, self-hosting, and API documentation.

## License

GNU Affero General Public License version 3 only.

## Frame-accurate trimming

```sh
npx densio --org ORG_ID --json jobs create SOURCE_ID trim --codec h265 --trim-start frame:300 --trim-end frame:750 --idempotency-key trim/demo
npx densio --org ORG_ID --json jobs create SOURCE_ID compress --trim-start frame:300 --trim-end frame:750 --idempotency-key compress/clip
npx densio --org ORG_ID --json plans create SOURCE_ID trim --codec vp9 --trim-start 00:00:10.125
```

`--trim-start` accepts a zero-based source frame (`frame:300`), seconds (`10.125`),
or timecode. `--trim-end` is exclusive; omitting it keeps the rest of the video.
Frame positions are resolved before frame-rate conversion. Time positions snap
forward to source frame boundaries; the execution snapshot reports the resolved range.
Standalone trim requires one output codec and re-encodes using shared CRF defaults.
It preserves cadence and applies the existing even-dimension encoder normalization.
Audio is kept when present; use `--audio remove` to omit it. Compression accepts its usual codecs, transforms, and audio policy.
Both paths quote only the selected duration and support the existing storage controls.
