import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { streamGrantedHls } from "../videos/hls-download.ts";
import type { streamGrantedVideo } from "../videos/video-stream.ts";
import {
  binaryResponse,
  emptyResponse,
  headerParameter,
  pathParameter,
  problemResponses,
} from "./openapi-support.ts";
import { rangeProblemDescriptor } from "./problems/storage-problems.ts";
import { videoStorageProblemDescriptors } from "./problems/video-storage-problems.ts";
import { beginRequest, runRouteEffect } from "./route-support.ts";

export const createVideoDownloadRoutes = (dependencies: {
  readonly downloadPackage?: (
    input: Parameters<typeof streamGrantedHls>[2],
  ) => ReturnType<typeof streamGrantedHls>;
  readonly createCorrelationId: () => string;
  readonly download: (
    input: Parameters<typeof streamGrantedVideo>[2],
  ) => ReturnType<typeof streamGrantedVideo>;
}) => {
  const routes = new Hono();
  routes.get(
    "/v1/video-downloads/:variantId/:token/:filename",
    describeRoute({
      operationId: "videoDownload",
      summary: "Stream a stored video with a revocable download grant",
      tags: ["Video storage"],
      description:
        "The URL contains a secret, short-lived grant. Every request verifies current organization membership and video state. Supports one byte range; responses must never be cached.",
      parameters: [
        pathParameter("variantId", "Variant identifier"),
        pathParameter("token", "Secret download grant"),
        pathParameter("filename", "Immutable video filename"),
        headerParameter("range", "One byte range"),
        headerParameter("if-range", "Entity tag"),
        headerParameter("if-none-match", "Entity tag"),
      ],
      responses: {
        "200": binaryResponse("Complete video"),
        "206": binaryResponse("Requested range"),
        "304": emptyResponse("Unchanged"),
        ...problemResponses(rangeProblemDescriptor, ...videoStorageProblemDescriptors),
      },
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const range = context.req.header("range");
      const ifRange = context.req.header("if-range");
      const ifNoneMatch = context.req.header("if-none-match");
      return runRouteEffect(
        context,
        correlationId,
        dependencies.download({
          variantId: context.req.param("variantId"),
          token: context.req.param("token"),
          filename: context.req.param("filename"),
          ...(range ? { range } : {}),
          ...(ifRange ? { ifRange } : {}),
          ...(ifNoneMatch ? { ifNoneMatch } : {}),
        }),
        (response) => response,
      );
    },
  );
  const packageDownload = dependencies.downloadPackage;
  if (packageDownload)
    routes.get(
      "/v1/hls-downloads/:videoId/:token/:filename",
      describeRoute({
        operationId: "hlsPackageMemberDownload",
        summary: "Download an authorized HLS package file",
        tags: ["Video storage"],
        description:
          "The filename is a percent-encoded inventory path. Grants expire after 15 minutes and are revoked by membership loss, deletion, or a visibility revision. This is package download access; private playback URLs are not provided.",
        parameters: [
          pathParameter("videoId", "Stored video identifier"),
          pathParameter("token", "Secret package grant"),
          pathParameter("filename", "Percent-encoded inventory path, including its slash"),
          headerParameter("range", "One byte range"),
        ],
        responses: {
          "200": binaryResponse("Package member"),
          "206": binaryResponse("Requested range"),
          "304": emptyResponse("Unchanged"),
          ...problemResponses(rangeProblemDescriptor, ...videoStorageProblemDescriptors),
        },
      }),
      async (context) => {
        const correlationId = beginRequest(context, dependencies.createCorrelationId);
        const range = context.req.header("range");
        return runRouteEffect(
          context,
          correlationId,
          packageDownload({
            videoId: context.req.param("videoId"),
            token: context.req.param("token"),
            filename: context.req.param("filename"),
            ...(range ? { range } : {}),
          }),
          (response) => response,
        );
      },
    );
  return routes;
};
