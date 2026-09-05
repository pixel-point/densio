import type { ResolvedTrimRange } from "@densio/shared";

export const trimVideoFilters = (range: ResolvedTrimRange) => [
  `settb=expr=${range.timeBase.numerator}/${range.timeBase.denominator}`,
  `trim=start_frame=${range.startFrame}:end_frame=${range.endFrame}`,
  `setpts=PTS-(${range.startPts})`,
];

export const trimAudioFilters = (range: ResolvedTrimRange) => {
  const secondsPerTick = range.timeBase.numerator / range.timeBase.denominator;
  return [
    `atrim=start=${Number(range.startPts) * secondsPerTick}:end=${Number(range.endPts) * secondsPerTick}`,
    `asetpts=PTS-(${range.startPts}*${range.timeBase.numerator}/${range.timeBase.denominator})/TB`,
  ];
};
