import { open } from "node:fs/promises";

// Read only the bounded fragment headers; compressed mdat payloads stay on disk.
export const inspectHlsFragment = async (path: string, timescale: number, video: boolean) => {
  const file = await open(path, "r");
  const data = Buffer.alloc(65536);
  const bytes = await file.read(data).finally(() => file.close());
  const fragment = boxes(data.subarray(0, bytes.bytesRead), true).find(
    ({ type }) => type === "moof",
  );
  if (!fragment) throw new Error("Missing HLS movie fragment");
  const tracks = boxes(fragment.data).filter(({ type }) => type === "traf");
  if (tracks.length !== 1) throw new Error("Expected one HLS track per fragment");
  const children = boxes(tracks[0]!.data);
  const header = children.find(({ type }) => type === "tfhd")?.data;
  const decodeTime = children.find(({ type }) => type === "tfdt")?.data;
  const runs = children.filter(({ type }) => type === "trun");
  if (!header || !decodeTime || runs.length !== 1)
    throw new Error("Incomplete HLS fragment timing");
  const start =
    decodeTime[0] === 1 ? Number(decodeTime.readBigUInt64BE(4)) : decodeTime.readUInt32BE(4);
  const samples = inspectRun(runs[0]!.data, defaults(header));
  if (!Number.isSafeInteger(start) || start < 0 || (video && (samples.firstFlags & 0x10000) !== 0))
    throw new Error("HLS segment must start with an independent sample");
  return {
    start: start / timescale,
    end: (start + samples.duration) / timescale,
    presentation: (start + samples.firstCompositionOffset) / timescale,
  };
};

export const hlsTrackTimescale = (initialization: Buffer): number => {
  const find = (data: Buffer): number | undefined => {
    for (const box of boxes(data)) {
      if (box.type === "mdhd") return box.data.readUInt32BE(box.data[0] === 1 ? 20 : 12);
      if (["moov", "trak", "mdia"].includes(box.type)) {
        const result = find(box.data);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  };
  const timescale = find(initialization);
  if (!timescale) throw new Error("Missing HLS track timescale");
  return timescale;
};

const boxes = (data: Buffer, stopAtMedia = false) => {
  const result: Array<{ type: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (stopAtMedia && type === "mdat") break;
    if (size < 8 || offset + size > data.length) throw new Error("Invalid HLS MP4 header");
    result.push({ type, data: data.subarray(offset + 8, offset + size) });
    offset += size;
  }
  return result;
};

const defaults = (header: Buffer) => {
  const flags = header.readUInt32BE(0) & 0xffffff;
  const offset = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
  return {
    duration: flags & 8 ? header.readUInt32BE(offset) : 0,
    flags:
      flags & 32 ? header.readUInt32BE(offset + (flags & 8 ? 4 : 0) + (flags & 16 ? 4 : 0)) : 0,
  };
};

const inspectRun = (data: Buffer, fallback: ReturnType<typeof defaults>) => {
  const flags = data.readUInt32BE(0) & 0xffffff;
  const count = data.readUInt32BE(4);
  if (count === 0 || count > 10000) throw new Error("Invalid HLS sample count");
  const firstOffset = 8 + (flags & 1 ? 4 : 0);
  const firstFlags = flags & 4 ? data.readUInt32BE(firstOffset) : fallback.flags;
  let offset = firstOffset + (flags & 4 ? 4 : 0);
  let duration = 0;
  let firstCompositionOffset = 0;
  let sampleFlags = firstFlags;
  for (let index = 0; index < count; index += 1) {
    const sampleDuration = flags & 256 ? data.readUInt32BE(offset) : fallback.duration;
    if (!sampleDuration) throw new Error("Invalid HLS sample duration");
    duration += sampleDuration;
    offset += (flags & 256 ? 4 : 0) + (flags & 512 ? 4 : 0);
    if (flags & 1024 && index === 0) sampleFlags = data.readUInt32BE(offset);
    offset += flags & 1024 ? 4 : 0;
    if (flags & 2048 && index === 0)
      firstCompositionOffset = data[0] === 1 ? data.readInt32BE(offset) : data.readUInt32BE(offset);
    offset += flags & 2048 ? 4 : 0;
  }
  if (offset !== data.length) throw new Error("Invalid HLS sample run");
  return { duration, firstFlags: sampleFlags, firstCompositionOffset };
};
