import { downloadHlsPackage } from "./hls-download.ts";
import { join, resolve } from "node:path";
import { stageVerifiedArtifact } from "./artifact-download.ts";
import { publishVerifiedArtifact } from "./local-output.ts";
import { invalidResponseError, CliUsageError } from "./cli-errors.ts";
import { jsonRequest } from "./http-client.ts";
import { controlRequestUrl } from "./control-request-policy.ts";
import { organizationPath, type OrganizationRuntime } from "./organization-context.ts";
import { emitSuccess } from "./render.ts";
import { storageResponses } from "./storage-responses.ts";

export const downloadStoredVideo = async (
  runtime: OrganizationRuntime,
  videoId: string,
  outputDirectory: string,
  force: boolean,
) => {
  const path = organizationPath(runtime, `/videos/${encodeURIComponent(videoId)}`);
  const response = await runtime.organizationClient.request(
    path,
    { method: "GET" },
    storageResponses.video,
  );
  if (response.data.video.videoId !== videoId) throw invalidResponseError();
  if (response.data.video.state !== "ready")
    throw new CliUsageError("The stored video is not ready for download.");
  if (response.data.video.hls)
    return downloadHlsPackage(runtime, response.data.video, outputDirectory, force);
  const files = [];
  for (const variant of response.data.video.variants) {
    const authorized = await runtime.organizationClient.request(
      `${path}/variants/${encodeURIComponent(variant.variantId)}/authorize`,
      jsonRequest("POST", {}),
      storageResponses.download,
    );
    if (authorized.data.videoId !== videoId || authorized.data.variantId !== variant.variantId)
      throw invalidResponseError();
    const outputPath = join(resolve(outputDirectory), variant.filename);
    const download = await stageVerifiedArtifact(
      runtime,
      controlRequestUrl(runtime, authorized.data.download.url).toString(),
      outputPath,
      variant,
    );
    await publishVerifiedArtifact(download.temporaryPath, outputPath, force);
    files.push({
      variantId: variant.variantId,
      filename: variant.filename,
      path: outputPath,
      bytes: download.bytes,
      sha256: download.sha256,
      verified: true,
    });
  }
  emitSuccess(
    runtime,
    {
      ...response,
      data: {
        organizationId: response.data.organizationId,
        videoId,
        outputDirectory: resolve(outputDirectory),
        files,
      },
    },
    `Downloaded ${files.length} verified video files into ${resolve(outputDirectory)}.\n`,
  );
};
