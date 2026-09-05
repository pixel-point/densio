export interface FfmpegProgressRecord {
  readonly frame?: number;
  readonly outTimeSeconds?: number;
  readonly progress: "continue" | "end";
  readonly speed?: number;
}

export const makeFfmpegProgressParser = (observe: (record: FfmpegProgressRecord) => void) => {
  const decoder = new TextDecoder();
  const diagnostics: Array<string> = [];
  let pending = "";
  let fields: Omit<FfmpegProgressRecord, "progress"> = {};

  const consumeLine = (encodedLine: string) => {
    const line = encodedLine.endsWith("\r") ? encodedLine.slice(0, -1) : encodedLine;
    const separator = line.indexOf("=");
    if (separator < 1) {
      if (line.length > 0) diagnostics.push(`${line}\n`);
      return;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "progress") {
      if (value === "continue" || value === "end") observe({ ...fields, progress: value });
      fields = {};
      return;
    }
    if (key === "frame") {
      const frame = Number(value);
      if (Number.isSafeInteger(frame) && frame >= 0) fields = { ...fields, frame };
      return;
    }
    if (key === "out_time_us" || key === "out_time_ms") {
      const microseconds = Number(value);
      if (Number.isFinite(microseconds) && microseconds >= 0) {
        fields = { ...fields, outTimeSeconds: microseconds / 1_000_000 };
      }
      return;
    }
    if (key === "speed") {
      const speed = Number(value.endsWith("x") ? value.slice(0, -1) : value);
      if (Number.isFinite(speed) && speed >= 0) fields = { ...fields, speed };
      return;
    }
    if (progressProtocolKey.test(key)) return;
    diagnostics.push(`${line}\n`);
  };

  const consume = (text: string) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(consumeLine);
  };

  return {
    finish: () => {
      consume(decoder.decode());
      if (pending.length > 0) consumeLine(pending);
      pending = "";
      return diagnostics.join("");
    },
    push: (chunk: string | Uint8Array) => {
      consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    },
  };
};

const progressProtocolKey =
  /^(?:bitrate|drop_frames|dup_frames|fps|out_time|stream_\d+_\d+_q|total_size)$/u;
