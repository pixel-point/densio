import type { MediaCodec } from "@densio/shared";
import { Effect } from "effect";

import type { Entitlements } from "../../auth/entitlements.ts";
import { MediaInspectionError } from "./media-inspection-error.ts";

interface DurationMetadata {
  readonly durationSeconds: number;
}

export const validateMediaEntitlements = Effect.fn("validateMediaEntitlements")(function* (
  media: DurationMetadata,
  codecs: ReadonlyArray<MediaCodec>,
  entitlements: Entitlements,
) {
  if (media.durationSeconds > entitlements.maxVideoDurationSeconds) {
    return yield* new MediaInspectionError({
      message: `Video duration exceeds the ${entitlements.maxVideoDurationSeconds}-second plan limit.`,
      reason: "duration-limit-exceeded",
    });
  }

  const forbiddenCodec = codecs.find((codec) => !entitlements.allowedCodecs.includes(codec));
  if (forbiddenCodec !== undefined) {
    return yield* new MediaInspectionError({
      message: `${forbiddenCodec.toUpperCase()} is not available on the ${entitlements.plan} plan.`,
      reason: "codec-not-entitled",
    });
  }

  return yield* Effect.void;
});
