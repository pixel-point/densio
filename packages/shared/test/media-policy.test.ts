import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPRESSION_CODECS,
  MEDIA_CODEC_CAPABILITIES,
  MEDIA_CODEC_POLICY,
  MEDIA_CODECS,
  MediaCodecSchema,
  type MediaCodec,
} from "../src/index.ts";

describe("media codec policy", () => {
  it("keeps the codec schema and registry in lockstep", () => {
    const decode = Schema.decodeUnknownSync(MediaCodecSchema);

    expect(MEDIA_CODECS.map((codec) => decode(codec))).toEqual(MEDIA_CODECS);
    expect(Object.keys(MEDIA_CODEC_POLICY)).toEqual(MEDIA_CODECS);
    expect(MEDIA_CODEC_CAPABILITIES).toEqual(
      MEDIA_CODECS.map((codec) => MEDIA_CODEC_POLICY[codec]),
    );
  });

  it("defines one canonical default compression codec tuple", () => {
    expect(DEFAULT_COMPRESSION_CODECS).toEqual(["vp9", "h265"]);
    expect(
      MEDIA_CODEC_CAPABILITIES.every((capability) => !("defaultCompression" in capability)),
    ).toBe(true);
  });

  it("defines the product default CRF for every codec", () => {
    expect(
      Object.fromEntries(
        MEDIA_CODECS.map((codec) => [codec, MEDIA_CODEC_POLICY[codec].defaultCrf]),
      ),
    ).toEqual({ av1: 42, h265: 30, vp9: 42 });
  });

  it.each(MEDIA_CODECS)("defines valid CRF boundaries for %s", (codec) => {
    const policy = MEDIA_CODEC_POLICY[codec];

    expect(policy.defaultCrf).toBeGreaterThanOrEqual(policy.crfRange.minimum);
    expect(policy.defaultCrf).toBeLessThanOrEqual(policy.crfRange.maximum);
  });

  it("retains a closed media-codec type", () => {
    const codec: MediaCodec = "av1";

    expect(codec).toBe("av1");
  });

  it("makes every codec available on the Free plan", () => {
    expect(MEDIA_CODECS.map((codec) => MEDIA_CODEC_POLICY[codec].minimumPlan)).toEqual([
      "free",
      "free",
      "free",
    ]);
  });
});
