import { queryParameters } from "./openapi-support.ts";
import {
  SourceUploadSessionResponseSchema,
  SourceUploadPartsRequestSchema,
  SourceUploadPartsResponseSchema,
} from "@densio/shared";
import { createVideoDownloadRoutes } from "./video-downloads.ts";
import {
  StorageConnectionRotateRequestSchema,
  VideoDownloadResponseSchema,
  VideoPackageDownloadResponseSchema,
  VideoExportRequestSchema,
  StorageConnectionCreateRequestSchema,
  StorageConnectionCreateResponseSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResponseSchema,
  StorageConnectionOperationResponseSchema,
  StorageSettingsSchema,
  StorageSettingsResponseSchema,
  StorageUsageResponseSchema,
  VideoSaveRequestSchema,
  VideoMutationResponseSchema,
  VideoListResponseSchema,
  VideoListQuerySchema,
  VideoResponseSchema,
  VideoRenameRequestSchema,
  VideoVisibilityRequestSchema,
  VideoDeleteRequestSchema,
  StorageTransferResponseSchema,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import {
  registerStorageRoute,
  storageIdempotency,
  type StorageRouteDependencies,
} from "./storage-route-support.ts";

export type { StorageRouteDependencies } from "./storage-route-support.ts";
const Empty = Schema.Struct({});
const base = "/v1/organizations/:organizationId";
export const createStorageRoutes = (dependencies: StorageRouteDependencies) => {
  const routes = new Hono();
  registerStorageSettings(routes, dependencies);
  registerStorageConnections(routes, dependencies);
  registerVideoCatalog(routes, dependencies);
  registerVideoLifecycle(routes, dependencies);
  registerConnectionOperations(routes, dependencies);
  registerVideoRecovery(routes, dependencies);
  registerSourceUploads(routes, dependencies);
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/videos/:videoId/package/authorize`,
    operationId: "videoPackageAuthorize",
    summary: "Authorize verified HLS package file downloads",
    request: Empty,
    response: VideoPackageDownloadResponseSchema,
    body: true,
    handle: (actor, _request, context) =>
      dependencies.videoService.authorizePackage({
        ...actor,
        videoId: context.req.param("videoId") ?? "",
      }),
  });
  if (dependencies.download)
    routes.route(
      "/",
      createVideoDownloadRoutes({
        createCorrelationId: dependencies.createCorrelationId,
        download: dependencies.download,
        ...(dependencies.downloadPackage ? { downloadPackage: dependencies.downloadPackage } : {}),
      }),
    );
  return routes;
};

const registerStorageSettings = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const video = dependencies.videoService;
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/storage/usage`,
    operationId: "storageUsage",
    summary: "Read organization storage capacity",
    request: Empty,
    response: StorageUsageResponseSchema,
    handle: (actor) => video.usage(actor),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/storage/settings`,
    operationId: "storageSettings",
    summary: "Read storage defaults",
    request: Empty,
    response: StorageSettingsResponseSchema,
    handle: (actor) => video.settings(actor),
  });
  registerStorageRoute(routes, dependencies, {
    method: "patch",
    path: `${base}/storage/settings`,
    operationId: "storageSettingsUpdate",
    summary: "Set organization storage defaults",
    request: StorageSettingsSchema,
    response: StorageSettingsResponseSchema,
    body: true,
    handle: (actor, request) => video.updateSettings({ ...actor, ...request }),
  });
};

const registerStorageConnections = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const connections = dependencies.connectionService;
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/storage/connections`,
    operationId: "storageConnectionCreate",
    summary: "Connect an S3-compatible destination",
    request: StorageConnectionCreateRequestSchema,
    response: StorageConnectionCreateResponseSchema,
    body: true,
    created: 201,
    idempotent: true,
    handle: (actor, request, context) =>
      Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
        connections.create({ ...actor, request, idempotencyKey }),
      ),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/storage/connections`,
    operationId: "storageConnectionsList",
    allowClosed: true,
    summary: "List storage connections",
    request: Empty,
    response: StorageConnectionListResponseSchema,
    handle: (actor) => connections.list(actor),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/storage/connections/:connectionId`,
    operationId: "storageConnectionGet",
    allowClosed: true,
    summary: "Read connection state",
    request: Empty,
    response: StorageConnectionResponseSchema,
    handle: (actor, _request, context) =>
      connections.get({ ...actor, connectionId: context.req.param("connectionId") ?? "" }),
  });
  for (const kind of ["validate", "disable", "disconnect"] as const)
    registerStorageRoute(routes, dependencies, {
      method: "post",
      path: `${base}/storage/connections/:connectionId/${kind}`,
      operationId: `storageConnection${kind}`,
      summary: `${kind} a storage connection`,
      request: Empty,
      response: StorageConnectionOperationResponseSchema,
      body: true,
      created: 202,
      idempotent: true,
      handle: (actor, _request, context) =>
        Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
          connections.operate({
            ...actor,
            connectionId: context.req.param("connectionId") ?? "",
            kind,
            idempotencyKey,
          }),
        ),
    });
};

const registerVideoCatalog = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const video = dependencies.videoService;
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/videos`,
    operationId: "videoSave",
    summary: "Save a completed compression",
    request: VideoSaveRequestSchema,
    response: VideoMutationResponseSchema,
    body: true,
    created: 202,
    idempotent: true,
    handle: (actor, request, context) =>
      Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
        video.save({ ...actor, ...request, idempotencyKey }),
      ),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/videos`,
    operationId: "videosList",
    summary: "List saved videos",
    request: VideoListQuerySchema,
    parameters: queryParameters(VideoListQuerySchema, {
      state: "Filter storage state",
      limit: "Page size (1–100)",
      cursor: "Continue the same filtered listing",
    }),
    query: (context) => ({
      ...context.req.query(),
      ...(context.req.query("limit") !== undefined
        ? { limit: Number(context.req.query("limit")) }
        : {}),
    }),
    response: VideoListResponseSchema,
    handle: (actor, query) => video.list({ ...actor, ...query }),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/videos/:videoId`,
    operationId: "videoGet",
    summary: "Read saved video and delivery state",
    request: Empty,
    response: VideoResponseSchema,
    handle: (actor, _request, context) =>
      video.get({ ...actor, videoId: context.req.param("videoId") ?? "" }),
  });
  registerStorageRoute(routes, dependencies, {
    method: "patch",
    path: `${base}/videos/:videoId`,
    operationId: "videoRename",
    summary: "Rename video display metadata without changing URLs",
    request: VideoRenameRequestSchema,
    response: VideoResponseSchema,
    body: true,
    handle: (actor, request, context) =>
      video.rename({ ...actor, videoId: context.req.param("videoId") ?? "", ...request }),
  });
};

const registerVideoLifecycle = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const video = dependencies.videoService;
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/videos/:videoId/visibility`,
    operationId: "videoVisibility",
    summary: "Change managed video visibility",
    request: VideoVisibilityRequestSchema,
    response: VideoMutationResponseSchema,
    body: true,
    created: 202,
    idempotent: true,
    handle: (actor, request, context) =>
      Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
        video.changeVisibility({
          ...actor,
          videoId: context.req.param("videoId") ?? "",
          ...request,
          idempotencyKey,
        }),
      ),
  });
  registerStorageRoute(routes, dependencies, {
    method: "delete",
    path: `${base}/videos/:videoId`,
    operationId: "videoDelete",
    summary: "Withdraw and delete saved video objects",
    request: VideoDeleteRequestSchema,
    response: VideoMutationResponseSchema,
    body: true,
    created: 202,
    idempotent: true,
    handle: (actor, request, context) =>
      Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
        video.remove({
          ...actor,
          videoId: context.req.param("videoId") ?? "",
          ...request,
          idempotencyKey,
        }),
      ),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/storage/transfers/:transferId`,
    operationId: "storageTransferGet",
    summary: "Read durable delivery progress",
    request: Empty,
    response: StorageTransferResponseSchema,
    handle: (actor, _request, context) =>
      video.transfer({ ...actor, transferId: context.req.param("transferId") ?? "" }),
  });
};

const registerConnectionOperations = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const connections = dependencies.connectionService;
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/storage/connections/:connectionId/rotate`,
    operationId: "storageConnectionRotate",
    summary: "Validate and rotate connection credentials",
    request: StorageConnectionRotateRequestSchema,
    response: StorageConnectionOperationResponseSchema,
    body: true,
    created: 202,
    idempotent: true,
    handle: (actor, request, context) =>
      Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
        connections.operate({
          ...actor,
          connectionId: context.req.param("connectionId") ?? "",
          kind: "rotate",
          ...request,
          idempotencyKey,
        }),
      ),
  });
  registerStorageRoute(routes, dependencies, {
    method: "get",
    path: `${base}/storage/operations/:operationId`,
    operationId: "storageConnectionOperationGet",
    allowClosed: true,
    summary: "Read connection operation and cleanup obligations",
    request: Empty,
    response: StorageConnectionOperationResponseSchema,
    handle: (actor, _request, context) =>
      connections.operation({ ...actor, operationId: context.req.param("operationId") ?? "" }),
  });
};

const registerVideoRecovery = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const video = dependencies.videoService;
  for (const action of ["retry", "cancel", "forget"] as const)
    registerStorageRoute(routes, dependencies, {
      method: "post",
      path: `${base}/videos/:videoId/${action}`,
      operationId: `video${action}`,
      summary: `${action} a stored video`,
      request: Empty,
      response: VideoMutationResponseSchema,
      body: true,
      created: 202,
      idempotent: true,
      handle: (actor, _request, context) =>
        Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
          video.recover({
            ...actor,
            videoId: context.req.param("videoId") ?? "",
            action,
            idempotencyKey,
          }),
        ),
    });
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/videos/:videoId/exports`,
    operationId: "videoExport",
    summary: "Copy stored video to a customer connection without re-encoding",
    request: VideoExportRequestSchema,
    response: VideoMutationResponseSchema,
    body: true,
    created: 202,
    idempotent: true,
    handle: (actor, request, context) =>
      Effect.flatMap(storageIdempotency(context), (idempotencyKey) =>
        video.export({
          ...actor,
          videoId: context.req.param("videoId") ?? "",
          ...request,
          idempotencyKey,
        }),
      ),
  });
  registerStorageRoute(routes, dependencies, {
    method: "post",
    path: `${base}/videos/:videoId/variants/:variantId/authorize`,
    operationId: "videoAuthorize",
    summary: "Authorize a short-lived stored video download",
    request: Empty,
    response: VideoDownloadResponseSchema,
    body: true,
    handle: (actor, _request, context) =>
      video.authorize({
        ...actor,
        videoId: context.req.param("videoId") ?? "",
        variantId: context.req.param("variantId") ?? "",
      }),
  });
};

const registerSourceUploads = (routes: Hono, dependencies: StorageRouteDependencies) => {
  const sourceUploads = dependencies.sourceUploads;
  if (sourceUploads) {
    for (const method of ["get", "post"] as const)
      registerStorageRoute(routes, dependencies, {
        method,
        path: `${base}/sources/:sourceId/storage-upload`,
        operationId: `sourceStorageSession${method}`,
        summary: "Read direct source upload session and verified part inventory",
        request: Empty,
        response: SourceUploadSessionResponseSchema,
        handle: (actor, _request, context) =>
          sourceUploads.status({ ...actor, sourceId: context.req.param("sourceId") ?? "" }),
      });
    registerStorageRoute(routes, dependencies, {
      method: "post",
      path: `${base}/sources/:sourceId/storage-upload/parts`,
      operationId: "sourceStorageParts",
      summary: "Authorize up to four direct multipart PUT actions",
      request: SourceUploadPartsRequestSchema,
      response: SourceUploadPartsResponseSchema,
      body: true,
      handle: (actor, request, context) =>
        sourceUploads.parts({
          ...actor,
          sourceId: context.req.param("sourceId") ?? "",
          ...request,
        }),
    });
    registerStorageRoute(routes, dependencies, {
      method: "post",
      path: `${base}/sources/:sourceId/storage-upload/commit`,
      operationId: "sourceStorageCommit",
      summary: "Close upload grants and commit verified multipart inventory",
      request: Empty,
      response: SourceUploadSessionResponseSchema,
      body: true,
      created: 202,
      handle: (actor, _request, context) =>
        sourceUploads.commit({ ...actor, sourceId: context.req.param("sourceId") ?? "" }),
    });
  }
};
