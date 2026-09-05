# HLS profile verification — September 5, 2026

The initial `hevc-vod-1` profile uses libx265 `veryslow`, Main10, shared compression CRF 30,
closed GOPs, approximately two-second IDRs and six-second fMP4 segments. CRF remains a user
quality target; benchmarks never change an explicit CRF or introduce a separate HLS default.

## Method and results

FFmpeg/FFprobe 8.1.2 on Apple Silicon/macOS, two x265 pool threads and one frame thread.
Three 30-second 640×360/30 fps scenes, each spanning five segments. The animation excerpts
start at 60 and 420 seconds in Blender's
[Big Buck Bunny](https://peach.blender.org/about/), licensed CC BY 3.0, © Blender Foundation.
The downloaded movie is from the
[official movie collection](https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_640x360.m4v.zip);
its SHA-256 is `738e2f999860553d056dd79c952f58f63cbb73892a57c72342ce9e5330d9d2d7`.
The third scene is deterministic FFmpeg testsrc2 with temporal noise (strength 8, seed 42).
References are FFV1; the animation reference is already compressed upstream. No reference
movies or generated media are bundled in the repository.

All cases use CRF 30. SSIM/PSNR compare decoded frames with the same reference after timestamp
normalization and conversion to 8-bit 4:2:0. These metrics do not measure 10-bit gradient
preservation or replace visual/perceptual evaluation. Timing was measured on a development
machine with other verification work running, so CPU figures are indicative.

| Scene            | Profile          | Package bytes | Encode seconds | Peak kb/s |    SSIM | PSNR dB |
| ---------------- | ---------------- | ------------: | -------------: | --------: | ------: | ------: |
| Calm animation   | Main, uncapped   |       807,207 |           75.1 |     284.9 | .961932 | 33.0805 |
| Calm animation   | Main10, uncapped |       798,521 |          103.8 |     290.1 | .960001 | 33.0168 |
| Calm animation   | Main10, capped   |       856,884 |          106.7 |     318.4 | .960865 | 33.0481 |
| Action animation | Main, uncapped   |     1,689,219 |          143.1 |     639.2 | .932091 | 29.0663 |
| Action animation | Main10, uncapped |     1,681,721 |          167.7 |     641.3 | .930210 | 29.0363 |
| Action animation | Main10, capped   |     1,650,159 |          152.8 |     601.1 | .929548 | 29.0215 |
| Motion/noise     | Main, uncapped   |     1,423,032 |           89.7 |     381.2 | .774247 | 27.7144 |
| Motion/noise     | Main10, uncapped |     1,463,063 |          116.3 |     392.3 | .772376 | 27.6786 |
| Motion/noise     | Main10, capped   |     1,496,659 |          115.3 |     401.1 | .772546 | 27.6818 |

[Machine-readable results](results.json) retain full precision. Main10 did **not** consistently
improve compression on these 8-bit sources: uncapped sizes varied from 1.1% smaller to 2.8%
larger, with slightly lower objective scores and more CPU time. Main10 is retained as one
consistent output profile that can accept 10-bit SDR without first reducing it to 8-bit.
This is a precision/compatibility choice, not a claim that Main10 wins every rate-distortion
comparison. Main10 decoding is part of the playback compatibility requirement.

The default video ceiling is `max(150000, ceil(width × height × fps × 0.1))` bits/s with
a two-second buffer. At 360p/30 this is 691,200 bits/s, approximately 8% above the largest
observed uncapped Main10 segment rate. The corresponding capped cases reduced SSIM by at
most .000662 versus uncapped Main10. The tiny-output floor was exercised by the two-level
browser fixture. Pixel/frame-rate scaling to larger sources is an extrapolation, not a
measured universal optimum. At 720p/30 and 1080p/30 it yields 2.7648 and 6.2208 Mb/s.
VBV can constrain quality on difficult material; use `rateControl: {mode: "crf"}` to remove
the ceiling, or supply explicit rendition limits. Neither choice changes the requested CRF.
Playlist BANDWIDTH is calculated from the encoded segments and shared AAC, never copied
from these video ceilings.

Reproduce from the repository root with a locally downloaded source movie:

```sh
pnpm --filter @densio/api exec node --import tsx scripts/benchmark-hls.ts /absolute/path/BigBuckBunny_640x360.m4v /absolute/path/benchmark-output
```

The script uses production command construction and package finalization. It deletes only
the reference intermediates it creates after measuring each scene; the input movie remains.

## Playback and lifecycle evidence

- Chrome 152 on this Mac with hls.js 1.6.16 played the generated HEVC Main10 package with two
  29.97 fps renditions and one AAC track. Seeking to eight seconds and switching levels
  completed; 178 decoded frames, zero dropped frames, no fatal player errors. The fixture was
  served locally with HLS MIME types and CORS. Local evidence: `output/playwright/hls-chrome.txt`.
- Native Safari 18.6 could not be automated because “Allow remote automation” is disabled.
  An older installed Playwright WebKit runtime also did not launch. Safari/device verification
  remains an external release check; Chrome/hls.js success is not proof of universal support.
- Deterministic API tests cover independent decoding of every segment, actual fMP4 decode
  timestamps and sync flags, 29.97 fps alignment, very short clips, VFR, delayed audio,
  rotated/anamorphic geometry, SDR color metadata, and rejection of unsupported sources.
- Lifecycle tests cover master-last publication, small-file PUT, public delivery checks,
  partial-upload recovery, private member downloads, checksums, visibility changes, cleanup,
  managed capacity, and customer export after the temporary archive has been removed.
- The local golden journey submits HLS directly through the built CLI/API, waits, downloads
  and verifies its ZIP, probes the HEVC playlist, replays the request, and deletes the artifact.

The deployment's read-only `/opt/ffmpeg` bundle is not mounted in this local environment.
Production bundle validation and native Safari/device playback therefore remain release
prerequisites. HLS/fMP4, libx265 Main10 and AAC were exercised with the local toolchain.
