import {
  StorageConnectionCreateResponseSchema,
  StorageConnectionListResponseSchema,
  StorageConnectionResponseSchema,
  StorageConnectionOperationResponseSchema,
  StorageUsageResponseSchema,
  StorageSettingsResponseSchema,
  StorageTransferResponseSchema,
  VideoMutationResponseSchema,
  VideoResponseSchema,
  VideoListResponseSchema,
  VideoDownloadResponseSchema,
  VideoPackageDownloadResponseSchema,
} from "@densio/shared";
import { organizationResponse } from "./organization-client.ts";

export const storageResponses = {
  connectionCreated: organizationResponse(StorageConnectionCreateResponseSchema, (value) => [
    value,
    value.connection,
  ]),
  connections: organizationResponse(StorageConnectionListResponseSchema, (value) => [
    value,
    ...value.connections,
  ]),
  connection: organizationResponse(StorageConnectionResponseSchema, (value) => [
    value,
    value.connection,
  ]),
  operation: organizationResponse(StorageConnectionOperationResponseSchema, (value) => [
    value,
    value.operation,
  ]),
  usage: organizationResponse(StorageUsageResponseSchema, (value) => [value, value.usage]),
  settings: organizationResponse(StorageSettingsResponseSchema, (value) => [value]),
  transfer: organizationResponse(StorageTransferResponseSchema, (value) => [value, value.transfer]),
  video: organizationResponse(VideoResponseSchema, (value) => [value, value.video]),
  videoMutation: organizationResponse(VideoMutationResponseSchema, (value) => [value, value.video]),
  videos: organizationResponse(VideoListResponseSchema, (value) => [value, ...value.videos]),
  packageDownload: organizationResponse(VideoPackageDownloadResponseSchema, (value) => [value]),
  download: organizationResponse(VideoDownloadResponseSchema, (value) => [value]),
};
