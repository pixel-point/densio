// ISO/IEC 14496-15 codec signaling is derived from the encoded initialization data.
// FFmpeg can omit its master entry for uncapped CRF or very short video-only outputs.
export const hevcCodecFromInitialization = (data: Buffer) => {
  if (data.length > 1048576) throw new Error("Oversized HEVC initialization segment");
  const config = findConfiguration(data, 0, data.length);
  if (!config || config.length < 23 || config.readUInt8(0) !== 1)
    throw new Error("Invalid HEVC decoder configuration");
  const flags = config.readUInt8(1);
  const compatibility = config
    .readUInt32BE(2)
    .toString(2)
    .padStart(32, "0")
    .split("")
    .toReversed()
    .join("");
  const constraints = [...config.subarray(6, 12)];
  const lastConstraint = constraints.findLastIndex((byte) => byte !== 0);
  return [
    "hvc1",
    `${["", "A", "B", "C"][flags >> 6]}${flags & 31}`,
    Number.parseInt(compatibility, 2).toString(16).toUpperCase(),
    `${(flags & 32) === 0 ? "L" : "H"}${config.readUInt8(12)}`,
    ...constraints
      .slice(0, lastConstraint + 1)
      .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()),
  ].join(".");
};

const findConfiguration = (data: Buffer, start: number, end: number): Buffer | undefined => {
  let offset = start;
  while (offset + 8 <= end) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > end) throw new Error("Invalid MP4 initialization box");
    if (type === "hvcC") return data.subarray(offset + 8, offset + size);
    if (["moov", "trak", "mdia", "minf", "stbl", "stsd", "hvc1"].includes(type)) {
      const child = findConfiguration(
        data,
        offset + 8 + (type === "stsd" ? 8 : type === "hvc1" ? 78 : 0),
        offset + size,
      );
      if (child) return child;
    }
    offset += size;
  }
  return undefined;
};
