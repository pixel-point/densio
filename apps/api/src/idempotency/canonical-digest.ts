import { createHash } from "node:crypto";

export const canonicalDigest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Request digests require JSON values");
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
};
