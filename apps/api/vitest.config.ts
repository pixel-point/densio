import { defineConfig } from "vitest/config";

// Native media tests execute the real encoder/probe; fast tests use local services and fixtures.
const media = [
  "media-bit-depth",
  "hls-workflow",
  "hls-source-edge-cases",
  "hls-job",
  "media-job-adapter",
  "trim-audio",
  "trim-job",
  "trim-output-verification",
  "trim-timeline",
  "trim-transform",
].map((name) => `test/${name}.test.ts`);
export default defineConfig({
  test: {
    projects: [
      { test: { name: "fast", globals: true, include: ["test/**/*.test.ts"], exclude: media } },
      { test: { name: "media", globals: true, include: media } },
    ],
  },
});
