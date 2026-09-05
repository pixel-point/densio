import type { SourceInspection } from "@densio/shared";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";

// Older snapshots predate color/timing inspection. Compare all facts they recorded;
// new snapshots additionally fence every new media property.
export const matchesPlannedInspection = (planned: SourceInspection, current: SourceInspection) => {
  const { videoProperties, ...inspection } = current;
  const projected = {
    ...inspection,
    ...(planned.videoProperties === undefined ? {} : { videoProperties }),
    audioStreams: current.audioStreams.map(
      ({ channels, sampleRate, startTimeSeconds, ...stream }) => {
        const recorded = planned.audioStreams.find(({ index }) => index === stream.index);
        return {
          ...stream,
          ...(recorded?.channels === undefined ? {} : { channels }),
          ...(recorded?.sampleRate === undefined ? {} : { sampleRate }),
          ...(recorded?.startTimeSeconds === undefined ? {} : { startTimeSeconds }),
        };
      },
    ),
  };
  return canonicalDigest(planned) === canonicalDigest(projected);
};
