# HLS packages

Use `jobs create SOURCE_ID hls --idempotency-key KEY` to encode from the original source into HEVC/H.265 Main10 SDR, fMP4 VOD, and one shared AAC track. The API chooses up to three source-aware renditions with no upscaling. It returns one `hls.zip` artifact and a package identity. `plans create SOURCE_ID hls` is an optional preview.

The H.265 CRF default is shared with ordinary compression (currently 30). Precedence is rendition `crf.h265`, then request `crf.h265`, then the shared default. Never fill omitted CRFs locally or change them during benchmarking. CRFs are codec-specific and are not comparable numbers across codecs.

`--rate-control capped-crf` is the default. Every resolved rendition records its bitrate and buffer limits; difficult scenes may lose quality to satisfy those limits. `--rate-control crf` removes ceilings without changing CRF. HEVC uses the `veryslow` software encoder policy, closed GOPs, aligned IDRs about every two seconds, and segments about six seconds long. Fractional frame rates use a shared frame schedule. The API measures real segment bandwidth for playlists.

For an advanced ladder, save this options object and pass `--options-file PATH`:

```json
{
  "crf": { "h265": 28 },
  "rateControl": { "mode": "capped-crf" },
  "ladder": {
    "mode": "custom",
    "renditions": [
      { "height": 360 },
      {
        "height": 720,
        "crf": { "h265": 26 },
        "maxVideoBitrateBps": 3000000,
        "videoBufferSizeBits": 6000000
      }
    ]
  }
}
```

Those explicit bitrate values are examples, not API defaults. Use one to three unique heights within the source, with aspect ratio preserved and even output dimensions. Do not mix the options file with individual workflow flags. Storage and execution controls remain independently usable. Explicit ceilings with uncapped CRF are rejected.

The initial profile accepts progressive SDR. HDR/BT.2020 and interlaced input require transforms outside this release. The selected video and first audio stream are used; extra audio tracks, subtitles, chapters, and attachments are omitted. Audio `auto` omits absent/silent audio; `keep` requires an audio stream; `remove` makes video-only HLS.

`--destination temporary` yields a downloadable ZIP. Densio-managed storage and connected customer storage retain every playlist, initialization file, and segment under one video. Only a ready public video exposes `hls.playbackUrl` and embed HTML; advertise that master playlist after verification. The CDN must serve playlist MIME types, cross-origin GET access, and media byte ranges. Customer storage requires compatible public delivery configuration.

HEVC playback depends on the browser, operating system, hardware, and player. Native HLS support alone does not prove HEVC support; an MSE player such as hls.js also needs a working HEVC decoder. This release supplies no H.264 fallback, AV1 HLS, VP9 HLS, live streaming, DRM, or private playback sessions.

For a private or public stored package, `videos download VIDEO_ID --output-dir DIR` retrieves the authoritative inventory and downloads every file with byte-count and SHA-256 verification. This works after the temporary ZIP expires. It creates a local package tree; it does not expose a private streaming URL. The CLI renews grants during long downloads while keeping already verified staged files. Grants expire after 15 minutes and are revoked by membership loss, visibility changes, or deletion. Never persist grant URLs.

Encoding success and delivery readiness are separate. Retry the existing storage transfer while recoverable; retries do not re-encode or reserve new processing credits. Capacity counts the complete package once. Visibility, export, deletion, retention, and organization closure operate on the whole inventory. A package is not deleted until all required origin/cache withdrawal completes.

`maxOutputBytes` bounds the larger of package bytes and ZIP bytes. The server separately monitors their combined local scratch usage (including allocated filesystem blocks), with a default 20 GiB per HLS job via `HLS_MAX_SCRATCH_BYTES` and a 64 MiB free-space reserve. Sampling is every two seconds, so this is a cancellation guard rather than a filesystem quota. `HLS_SCRATCH_LIMIT_EXCEEDED` requires freeing server disk space or increasing that operational limit before retrying; do not silently lower CRF or remove renditions to bypass it.
