import { MediaPlanError } from "./media-plan-error.ts";

const finiteMetric = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;

export const parseSsimMetric = (output: string) => {
  const matches = [...output.matchAll(new RegExp(`All:(${finiteMetric})`, "gi"))];
  const value = Number(matches.at(-1)?.[1]);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MediaPlanError("INVALID_SSIM_METRIC", "FFmpeg did not report a valid SSIM score");
  }

  return value;
};

export const parsePsnrMetric = (output: string) => {
  const matches = [...output.matchAll(new RegExp(`average:(${finiteMetric}|inf)`, "gi"))];
  const encoded = matches.at(-1)?.[1];
  if (encoded?.toLowerCase() === "inf") return "infinite" as const;

  const value = Number(encoded);
  if (!Number.isFinite(value) || value <= 0) {
    throw new MediaPlanError("INVALID_PSNR_METRIC", "FFmpeg did not report a valid PSNR score");
  }

  return value;
};
