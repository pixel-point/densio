import type { MediaPosition } from "@densio/shared";
export const positionTime = (position: MediaPosition) => {
  if (position.kind === "frame") return undefined;
  if (position.kind === "seconds") return position.seconds;
  return position.timecode.split(":").reduce((seconds, field) => seconds * 60 + Number(field), 0);
};

export const secondsToTicks = (
  seconds: number,
  base: { numerator: number; denominator: number },
) => {
  const [mantissa = "0", exponent = "0"] = String(seconds).split("e");
  const fraction = mantissa.split(".")[1]?.length ?? 0;
  const power = Number(exponent) - fraction;
  const numerator =
    BigInt(mantissa.replace(".", "")) *
    BigInt(base.denominator) *
    10n ** BigInt(Math.max(0, power));
  const denominator = BigInt(base.numerator) * 10n ** BigInt(Math.max(0, -power));
  return (numerator + denominator - 1n) / denominator;
};
