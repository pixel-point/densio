import { dirname, join, resolve } from "node:path";
import type { Video } from "@densio/shared";
import { stageVerifiedArtifact } from "./artifact-download.ts";
import {
  preflightOutput,
  publishOutputBundle,
  cleanupTemporaryFiles,
  type StagedFile,
} from "./local-output.ts";
import { invalidResponseError } from "./cli-errors.ts";
import { controlRequestUrl } from "./control-request-policy.ts";
import { jsonRequest } from "./http-client.ts";
import { organizationPath, type OrganizationRuntime } from "./organization-context.ts";
import { emitSuccess } from "./render.ts";
import { storageResponses } from "./storage-responses.ts";

export const downloadHlsPackage = async (
  runtime: OrganizationRuntime,
  video: Video,
  requestedDirectory: string,
  force: boolean,
) => {
  const authorized = await authorizePackage(runtime, video);
  const outputDirectory = resolve(requestedDirectory);
  for (const member of authorized.data.package.members)
    await preflightOutput(
      dirname(join(outputDirectory, member.path)),
      [member.path.split("/").at(-1)!],
      force,
    );
  const staged: Array<StagedFile> = [];
  return Promise.resolve()
    .then(async () => {
      const files = [];
      let grant = authorized.data.download;
      for (const member of authorized.data.package.members) {
        if (Date.parse(grant.expiresAt) - runtime.now() < 60000)
          grant = (await authorizePackage(runtime, video)).data.download;
        const targetPath = join(outputDirectory, member.path);
        const url = controlRequestUrl(
          runtime,
          `${grant.baseUrl}${encodeURIComponent(member.path)}`,
        ).toString();
        const downloaded = await stageVerifiedArtifact(runtime, url, targetPath, member);
        staged.push({ targetPath, temporaryPath: downloaded.temporaryPath });
        files.push({
          filename: member.path,
          path: targetPath,
          bytes: member.bytes,
          sha256: member.sha256,
          verified: true,
        });
      }
      await publishOutputBundle(staged, force);
      emitSuccess(
        runtime,
        {
          ...authorized,
          data: {
            organizationId: video.organizationId,
            videoId: video.videoId,
            packageId: video.hls?.packageId,
            outputDirectory,
            files,
          },
        },
        `Downloaded ${files.length} verified HLS package files into ${outputDirectory}.\n`,
      );
    })
    .finally(() => cleanupTemporaryFiles(staged));
};

const authorizePackage = async (runtime: OrganizationRuntime, video: Video) => {
  const authorized = await runtime.organizationClient.request(
    organizationPath(runtime, `/videos/${encodeURIComponent(video.videoId)}/package/authorize`),
    jsonRequest("POST", {}),
    storageResponses.packageDownload,
  );
  if (
    authorized.data.videoId !== video.videoId ||
    authorized.data.package.packageId !== video.hls?.packageId ||
    authorized.data.package.packageBytes !== video.hls.packageBytes
  )
    throw invalidResponseError();
  return authorized;
};
