import type { CropOptions, ScaleOptions, TransformOptions } from "@densio/shared";

import { MediaPlanError } from "./media-plan-error.ts";

export type { CropOptions, ScaleOptions, TransformOptions } from "@densio/shared";

export interface VideoDimensions {
  readonly width: number;
  readonly height: number;
}

interface CropPlan extends VideoDimensions {
  readonly filter?: string;
}

interface ScalePlan extends VideoDimensions {
  readonly filter?: string;
}

export const buildVideoFilters = (source: VideoDimensions, transform: TransformOptions = {}) => {
  assertDimensions(source, "Source");
  const crop = buildCropPlan(source, transform.crop);
  const scale = buildScalePlan(crop, transform.scale);

  return [crop.filter, scale.filter].filter((filter): filter is string => filter !== undefined);
};

export const resolveVideoDimensions = (
  source: VideoDimensions,
  transform: TransformOptions = {},
) => {
  assertDimensions(source, "Source");
  const crop = buildCropPlan(source, transform.crop);
  const { width, height } = buildScalePlan(crop, transform.scale);
  return { height, width };
};

const buildCropPlan = (source: VideoDimensions, crop?: CropOptions): CropPlan => {
  if (crop === undefined) return source;
  if (crop.kind === "aspect-ratio") return buildAspectRatioCrop(source, crop.aspectRatio);
  if (crop.kind !== "rectangle") {
    throw new MediaPlanError("INVALID_CROP", "Crop kind is invalid");
  }

  [crop.width, crop.height, crop.x, crop.y].forEach((value, index) =>
    assertInteger(value, index < 2 ? "Crop dimension" : "Crop offset", index < 2 ? 1 : 0),
  );
  if (crop.x + crop.width > source.width || crop.y + crop.height > source.height) {
    throw new MediaPlanError("CROP_OUT_OF_BOUNDS", "Crop rectangle is outside source bounds");
  }

  return {
    width: crop.width,
    height: crop.height,
    filter: `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
  };
};

const buildAspectRatioCrop = (source: VideoDimensions, aspectRatio: string): CropPlan => {
  const match =
    typeof aspectRatio === "string" ? /^([1-9]\d*):([1-9]\d*)$/.exec(aspectRatio) : null;
  if (match === null) {
    throw new MediaPlanError("INVALID_ASPECT_RATIO", "Aspect ratio must use W:H integers");
  }

  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  assertInteger(ratioWidth, "Aspect ratio width", 1);
  assertInteger(ratioHeight, "Aspect ratio height", 1);
  const targetRatio = ratioWidth / ratioHeight;
  const sourceRatio = source.width / source.height;
  const width =
    sourceRatio > targetRatio ? evenFloor(source.height * targetRatio) : evenFloor(source.width);
  const height =
    sourceRatio > targetRatio ? evenFloor(source.height) : evenFloor(source.width / targetRatio);
  assertDimensions({ width, height }, "Aspect-ratio crop");
  const x = Math.floor((source.width - width) / 2);
  const y = Math.floor((source.height - height) / 2);

  return { width, height, filter: `crop=${width}:${height}:${x}:${y}` };
};

const buildScalePlan = (source: VideoDimensions, scale?: ScaleOptions): ScalePlan => {
  if (scale === undefined) return buildEvenDimensionPlan(source);
  if (typeof scale !== "object" || scale === null) {
    throw new MediaPlanError("INVALID_SCALE", "Scale options are invalid");
  }

  const hasWidth = "width" in scale;
  const hasHeight = "height" in scale;
  if (hasWidth === hasHeight) {
    throw new MediaPlanError("INVALID_SCALE", "Scale must contain exactly one of width or height");
  }
  if (scale.allowUpscale !== undefined && typeof scale.allowUpscale !== "boolean") {
    throw new MediaPlanError("INVALID_SCALE", "allowUpscale must be boolean");
  }
  if (hasWidth) return buildWidthScale(source, scale);

  return buildHeightScale(source, scale);
};

const buildWidthScale = (
  source: VideoDimensions,
  scale: { readonly width: number; readonly allowUpscale?: boolean },
): ScalePlan => {
  assertInteger(scale.width, "Scale width", 2);
  if (scale.width > source.width && scale.allowUpscale !== true) {
    throw new MediaPlanError("UPSCALING_DISABLED", "Width would upscale the video");
  }

  const width = evenFloor(scale.width);
  return {
    filter: `scale=${width}:-2`,
    height: proportionalEven(source.height, width, source.width),
    width,
  };
};

const buildHeightScale = (
  source: VideoDimensions,
  scale: { readonly height: number; readonly allowUpscale?: boolean },
): ScalePlan => {
  assertInteger(scale.height, "Scale height", 2);
  if (scale.height > source.height && scale.allowUpscale !== true) {
    throw new MediaPlanError("UPSCALING_DISABLED", "Height would upscale the video");
  }

  const height = evenFloor(scale.height);
  return {
    filter: `scale=-2:${height}`,
    height,
    width: proportionalEven(source.width, height, source.height),
  };
};

const buildEvenDimensionPlan = ({ width, height }: VideoDimensions): ScalePlan => {
  assertDimensions({ width, height }, "Output");
  if (width % 2 !== 0) return buildWidthScale({ width, height }, { width: evenFloor(width) });
  if (height % 2 !== 0) return buildHeightScale({ width, height }, { height: evenFloor(height) });

  return { height, width };
};

const evenFloor = (value: number) => Math.floor(value / 2) * 2;

const proportionalEven = (value: number, target: number, source: number) =>
  Math.max(2, Math.round((value * target) / source / 2) * 2);

const assertDimensions = ({ width, height }: VideoDimensions, label: string) => {
  assertInteger(width, `${label} width`, 2);
  assertInteger(height, `${label} height`, 2);
};

const assertInteger = (value: number, label: string, minimum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new MediaPlanError("INVALID_DIMENSION", `${label} must be an integer >= ${minimum}`);
  }
};
