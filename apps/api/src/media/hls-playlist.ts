export interface HlsPlaylistSegment {
  readonly path: string;
  readonly duration: number;
}

export const parseHlsMediaPlaylist = (text: string, directory: string) => {
  if (
    !text.startsWith("#EXTM3U\n") ||
    !text.includes("#EXT-X-ENDLIST") ||
    !text.includes(`#EXT-X-MAP:URI="init_${directory}.mp4"`) ||
    !text.includes("#EXT-X-PLAYLIST-TYPE:VOD")
  )
    throw new Error("Incomplete fMP4 VOD playlist");
  const matches = [...text.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^\n]+)/g)];
  const segments = matches.map((match) => ({
    duration: Number(match[1]),
    path: `${directory}/${match[2]}`,
  }));
  if (
    segments.length === 0 ||
    segments.some(
      ({ duration, path }) =>
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !/^(v[0-2]|audio)\/segment-\d{6}\.m4s$/.test(path),
    )
  )
    throw new Error("Invalid HLS segment reference");
  const references = text.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
  if (references.length !== segments.length || /#EXT-X-(?:KEY|BYTERANGE|DISCONTINUITY)/.test(text))
    throw new Error("Unexpected HLS references or discontinuities");
  const targetDuration = Number(text.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]);
  if (
    !Number.isSafeInteger(targetDuration) ||
    targetDuration < 1 ||
    segments.some(({ duration }) => Math.round(duration) > targetDuration)
  )
    throw new Error("Invalid HLS target duration");
  return {
    segments,
    targetDuration,
    duration: segments.reduce((sum, { duration }) => sum + duration, 0),
  };
};

export const measuredHlsBandwidth = (
  segments: ReadonlyArray<HlsPlaylistSegment & { readonly bytes: number }>,
  target: number,
) => {
  const average = Math.ceil(
    (segments.reduce((sum, segment) => sum + segment.bytes, 0) * 8) /
      segments.reduce((sum, segment) => sum + segment.duration, 0),
  );
  const peaks = segments.flatMap((_, start) => {
    let duration = 0;
    let bytes = 0;
    const rates: number[] = [];
    for (let index = start; index < segments.length; index += 1) {
      const segment = segments[index]!;
      duration += segment.duration;
      bytes += segment.bytes;
      if (duration > target * 1.5) break;
      if (duration >= target * 0.5) rates.push(Math.ceil((bytes * 8) / duration));
    }
    return rates;
  });
  return { average, peak: Math.max(average, ...peaks) };
};

export const nativeHevcCodec = (master: string, playlist: string) => {
  const entry = master.split("\n").findIndex((line) => line.trim() === playlist);
  const previous = master.split("\n")[entry - 1];
  const codecs = previous?.match(/CODECS="([^"]+)"/)?.[1]?.split(",");
  const codec = codecs?.find((value) => /^hvc1\.[A-Za-z0-9.]+$/.test(value));
  return codec;
};
