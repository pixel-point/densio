import { Effect, Schema } from "effect";

const ByteRangeHeaderSchema = Schema.String.check(
  Schema.isPattern(/^bytes=\d*-\d*$/i, { expected: "one byte range" }),
);
const decodeByteRangeHeader = Schema.decodeUnknownEffect(ByteRangeHeaderSchema);

export class RangeNotSatisfiable extends Schema.TaggedErrorClass<RangeNotSatisfiable>()(
  "RangeNotSatisfiable",
  {
    contentRange: Schema.String,
    message: Schema.String,
    status: Schema.Number,
  },
) {}

export type ByteRange = Readonly<{
  contentRange: string;
  end: number;
  length: number;
  start: number;
}>;

const notSatisfiable = (size: number) =>
  new RangeNotSatisfiable({
    contentRange: `bytes */${size}`,
    message: "The requested byte range is not satisfiable.",
    status: 416,
  });

const completeRange = (start: number, end: number, size: number): ByteRange => ({
  contentRange: `bytes ${start}-${end}/${size}`,
  end,
  length: end - start + 1,
  start,
});

const normalizeSuffixRange = (suffixText: string, size: number) => {
  const suffixLength = Number(suffixText);
  if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size <= 0) {
    return notSatisfiable(size);
  }

  return completeRange(Math.max(0, size - suffixLength), size - 1, size);
};

const normalizeExplicitRange = (startText: string, endText: string, size: number) => {
  const start = Number(startText);
  const requestedEnd = endText === "" ? size - 1 : Number(endText);
  const numbersAreSafe = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd);

  if (!numbersAreSafe || size <= 0 || start >= size || requestedEnd < start) {
    return notSatisfiable(size);
  }

  return completeRange(start, Math.min(requestedEnd, size - 1), size);
};

export const parseSingleRange = Effect.fn("Storage.parseSingleRange")(function* (
  headerInput: unknown,
  size: number,
) {
  if (headerInput === undefined) return undefined;

  const header = yield* decodeByteRangeHeader(headerInput).pipe(
    Effect.mapError(() => notSatisfiable(size)),
  );
  const [startText = "", endText = ""] = header.slice(header.indexOf("=") + 1).split("-");
  const normalized =
    startText === ""
      ? normalizeSuffixRange(endText, size)
      : normalizeExplicitRange(startText, endText, size);

  if (normalized instanceof RangeNotSatisfiable) return yield* normalized;
  return normalized;
});
