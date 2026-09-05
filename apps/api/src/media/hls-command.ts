import { join } from "node:path";
import type { ResolvedHlsOptions, SourceInspection } from "@densio/shared";
import { assertCommandPath, createCommandPlan } from "./command-plan.ts";
import { resolveAudioDecision, type AudioAnalysis } from "./compression-plan.ts";

export const buildHlsCommand = (input: {
  readonly executable?: string;
  readonly inputPath: string;
  readonly directory: string;
  readonly options: ResolvedHlsOptions;
  readonly source: SourceInspection;
  readonly audioAnalysis: AudioAnalysis;
}) => {
  assertCommandPath(input.inputPath, "Input");
  assertCommandPath(input.directory, "HLS output");
  const options = input.options;
  const audio = resolveAudioDecision(options.audio, input.audioAnalysis) === "keep";
  const variants = options.renditions.map(
    ({ id }, index) => `v:${index},name:${id}${audio ? ",agroup:audio" : ""}`,
  );
  return createCommandPlan(input.executable ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-filter_threads",
    "2",
    "-i",
    input.inputPath,
    ...options.renditions.flatMap(() => ["-map", `0:${options.videoStreamIndex}`]),
    ...(audio
      ? [
          "-map",
          `0:${options.audioStreamIndex}`,
          "-c:a",
          "aac",
          "-b:a",
          String(options.audioBitrateBps),
          "-ar",
          String(options.audioSampleRate),
          "-ac",
          String(options.audioChannels),
        ]
      : ["-an"]),
    ...options.renditions.flatMap((rendition, index) =>
      videoArguments(options, rendition, index, input.source),
    ),
    "-f",
    "hls",
    "-hls_segment_type",
    "fmp4",
    "-hls_time",
    String(options.segmentDurationSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_fmp4_init_filename",
    options.renditions.length === 1 && !audio ? "init_v0.mp4" : "init_%v.mp4",
    "-hls_segment_filename",
    join(input.directory, "%v", "segment-%06d.m4s"),
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    [...variants, ...(audio ? ["a:0,agroup:audio,default:yes,name:audio"] : [])].join(" "),
    join(input.directory, "%v", "index.m3u8"),
  ]);
};

const videoArguments = (
  options: ResolvedHlsOptions,
  rendition: ResolvedHlsOptions["renditions"][number],
  index: number,
  source: SourceInspection,
) => {
  const suffix = `:v:${index}`;
  const properties = source.videoProperties;
  return [
    `-c${suffix}`,
    "libx265",
    `-preset${suffix}`,
    options.preset,
    `-crf${suffix}`,
    String(rendition.crf.h265),
    `-tag${suffix}`,
    "hvc1",
    `-pix_fmt${suffix}`,
    options.pixelFormat,
    `-profile${suffix}`,
    "main10",
    `-filter${suffix}`,
    `scale=${rendition.width}:${rendition.height}:flags=lanczos,setsar=1,fps=${options.outputFrameRate.numerator}/${options.outputFrameRate.denominator}`,
    // The fps filter owns CFR. A second CFR conversion pads delayed video back
    // to zero and destroys its offset relative to an earlier audio track.
    `-fps_mode${suffix}`,
    "passthrough",
    `-forced-idr${suffix}`,
    "1",
    `-force_key_frames${suffix}`,
    `expr:gte(n,n_forced*${options.keyframeIntervalFrames})`,
    `-x265-params${suffix}`,
    `pools=2:frame-threads=1:open-gop=0:keyint=${options.keyframeIntervalFrames}:min-keyint=${options.keyframeIntervalFrames}:scenecut=0:repeat-headers=0`,
    ...(rendition.maxVideoBitrateBps === undefined
      ? []
      : [
          `-maxrate${suffix}`,
          String(rendition.maxVideoBitrateBps),
          `-bufsize${suffix}`,
          String(rendition.videoBufferSizeBits),
        ]),
    ...[
      ["color_primaries", properties?.colorPrimaries],
      ["color_trc", properties?.colorTransfer],
      ["colorspace", properties?.colorSpace],
      ["color_range", properties?.colorRange],
    ].flatMap(([name, value]) =>
      value === undefined || value === "unknown" ? [] : [`-${name}${suffix}`, value],
    ),
  ];
};
