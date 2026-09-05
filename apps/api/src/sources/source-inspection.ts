import { SourceInspectionSchema, type SourceInspection } from "@densio/shared";
import { Effect, Schema } from "effect";
import type { MediaProbe, MediaStream } from "../media/inspection/media-probe.ts";
import { SourceRepositoryError } from "./source-errors.ts";

export const normalizeSourceInspection = Effect.fn("PreparedSourceService.normalizeInspection")(
  function* (probe: MediaProbe) {
    const primary = probe.streams.find(({ index }) => index === probe.videoStreamIndex);
    const inspection = {
      ...(probe.videoProperties === undefined ? {} : { videoProperties: probe.videoProperties }),
      audioStreams: probe.audioStreamIndexes.map((index) => {
        const stream = probe.streams.find((candidate) => candidate.index === index);
        return {
          codec: stream?.codecName ?? "unknown",
          index,
          type: "audio" as const,
          ...(stream?.channels === undefined ? {} : { channels: stream.channels }),
          ...(stream?.sampleRate === undefined ? {} : { sampleRate: stream.sampleRate }),
          ...(stream?.startTimeSeconds === undefined
            ? {}
            : { startTimeSeconds: stream.startTimeSeconds }),
        };
      }),
      displayDimensions: probe.displayDimensions,
      durationSeconds: probe.durationSeconds,
      encodedDimensions: probe.encodedDimensions,
      frameRate: probe.frameRate,
      primaryVideoStream: {
        codec: primary?.codecName ?? "unknown",
        height: probe.encodedDimensions.height,
        index: probe.videoStreamIndex,
        type: "video" as const,
        width: probe.encodedDimensions.width,
      },
      rotationDegrees: normalizedRotation(probe.rotationDegrees),
      streams: probe.streams.map((stream) => ({
        ...(stream.codecName === undefined ? {} : { codec: stream.codecName }),
        index: stream.index,
        type: normalizedStreamType(stream),
      })),
    };
    return yield* Schema.decodeUnknownEffect(SourceInspectionSchema)(inspection).pipe(
      Effect.mapError(
        (cause) => new SourceRepositoryError({ cause, operation: "normalize-inspection" }),
      ),
    );
  },
);

const normalizedRotation = (rotation: number): 0 | 90 | 180 | 270 => {
  if (rotation === 90 || rotation === 180 || rotation === 270) return rotation;
  return 0;
};

const normalizedStreamType = (stream: MediaStream): SourceInspection["streams"][number]["type"] => {
  if (stream.type === "video") return "video";
  if (stream.type === "audio") return "audio";
  if (stream.type === "subtitle") return "subtitle";
  if (stream.type === "data") return "data";
  if (stream.type === "attachment") return "attachment";
  return "unknown";
};
