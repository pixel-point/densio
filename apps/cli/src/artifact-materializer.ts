import {
  preflightOutput,
  publishOutputBundle,
  stageTextFile,
  cleanupTemporaryFiles,
  type StagedFile,
} from "./local-output.ts";
import { organizationResponses } from "./organization-responses.ts";
import type { OrganizationRuntime } from "./organization-context.ts";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  ArtifactMaterializationReceiptSchema,
  type ArtifactDescriptor,
  type JobStatus,
  type MaterializedArtifactFile,
} from "@densio/shared";
import { Schema } from "effect";

import { stageVerifiedArtifact } from "./artifact-download.ts";
import { artifactOutputUnsafeError, invalidResponseError } from "./cli-errors.ts";
import { organizationPath } from "./organization-context.ts";

const HTML_FILENAME = "index.html";
const MANIFEST_FILENAME = "densio-manifest.json";

const decodeJobStatus = organizationResponses.JobStatus;
const decodeAuthorization = organizationResponses.ArtifactAuthorization;
const decodeReceipt = Schema.decodeUnknownSync(ArtifactMaterializationReceiptSchema);

export const materializeJobArtifacts = async (
  runtime: OrganizationRuntime,
  jobId: string,
  requestedOutputDirectory: string,
  force: boolean,
) => {
  const status = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/jobs/${encodeURIComponent(jobId)}`,
    { method: "GET" },
    decodeJobStatus,
  );
  if (status.data.state !== "succeeded")
    throw artifactOutputUnsafeError("Only succeeded jobs can be materialized.");
  const descriptors = status.data.artifacts.filter(
    ({ availability }) => availability === "available",
  );
  if (descriptors.length === 0) {
    throw artifactOutputUnsafeError("The succeeded job has no available artifacts to materialize.");
  }
  const outputDirectory = resolve(requestedOutputDirectory);
  const generatedNames =
    status.data.result.kind === "compress" ? [HTML_FILENAME, MANIFEST_FILENAME] : [];
  validateMaterializationNames(descriptors, generatedNames);
  await preflightOutput(
    outputDirectory,
    [...descriptors.map(({ filename }) => filename), ...generatedNames],
    force,
  );
  const staged: Array<StagedFile> = [];
  const files: Array<MaterializedArtifactFile> = [];
  try {
    for (const descriptor of descriptors) {
      const authorization = await authorize(runtime, descriptor.id);
      ensureAuthorizationMatches(descriptor, authorization.data.artifact);
      const targetPath = join(outputDirectory, descriptor.filename);
      const downloaded = await stageVerifiedArtifact(
        runtime,
        authorization.data.download.url,
        targetPath,
        { bytes: descriptor.bytes, sha256: descriptor.sha256 },
      );
      staged.push({ targetPath, temporaryPath: downloaded.temporaryPath });
      files.push({
        organizationId: status.data.organizationId,
        artifactId: descriptor.id,
        bytes: downloaded.bytes,
        filename: descriptor.filename,
        path: targetPath,
        sha256: downloaded.sha256,
        verified: true,
      });
    }
    const generated = await stageGeneratedFiles(outputDirectory, jobId, status.data, descriptors);
    staged.push(...generated.files);
    await publishOutputBundle(staged, force);
    return {
      correlationId: status.correlationId,
      data: decodeReceipt({
        files,
        ...(generated.htmlPath === undefined ? {} : { htmlPath: generated.htmlPath }),
        job: status.data,
        jobId,
        organizationId: status.data.organizationId,
        ...(generated.manifestPath === undefined ? {} : { manifestPath: generated.manifestPath }),
        outputDirectory,
      }),
      ok: true as const,
      schemaVersion: 1 as const,
    };
  } catch (cause) {
    await cleanupTemporaryFiles(staged);
    throw cause;
  }
};

const authorize = (runtime: OrganizationRuntime, artifactId: string) =>
  runtime.organizationClient.request(
    `${organizationPath(runtime)}/artifacts/${encodeURIComponent(artifactId)}/authorize`,
    { method: "POST" },
    decodeAuthorization,
  );

const validateMaterializationNames = (
  descriptors: ReadonlyArray<ArtifactDescriptor>,
  generatedNames: ReadonlyArray<string>,
) => {
  const names = [...descriptors.map(({ filename }) => filename), ...generatedNames];
  if (names.some((name) => !isSafeFilename(name))) {
    throw artifactOutputUnsafeError("Artifact filenames must be safe single path components.");
  }
  const comparable = names.map((name) => name.normalize("NFC").toLowerCase());
  if (new Set(comparable).size !== comparable.length) {
    throw artifactOutputUnsafeError("Artifact and generated filenames must be unique.");
  }
};

const isSafeFilename = (filename: string) => {
  if (filename.length === 0 || filename === "." || filename === "..") return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  return ![...filename].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
};

const stageGeneratedFiles = async (
  outputDirectory: string,
  jobId: string,
  status: Extract<JobStatus, { readonly state: "succeeded" }>,
  descriptors: ReadonlyArray<ArtifactDescriptor>,
) => {
  if (status.result.kind !== "compress") return { files: [] as Array<StagedFile> };
  const htmlPath = join(outputDirectory, HTML_FILENAME);
  const manifestPath = join(outputDirectory, MANIFEST_FILENAME);
  const html = renderRelativeHtml(descriptors);
  const manifest = `${JSON.stringify(
    {
      artifacts: descriptors.map(({ bytes, filename, id, mediaType, sha256 }) => ({
        artifactId: id,
        bytes,
        filename,
        mediaType,
        sha256,
      })),
      html: HTML_FILENAME,
      jobId,
      schemaVersion: 1,
    },
    null,
    2,
  )}\n`;
  const htmlFile = await stageTextFile(htmlPath, html);
  const manifestFile = await stageTextFile(manifestPath, manifest).catch(async (cause: unknown) => {
    await rm(htmlFile.temporaryPath, { force: true });
    throw cause;
  });
  return {
    files: [htmlFile, manifestFile],
    htmlPath,
    manifestPath,
  };
};

const renderRelativeHtml = (descriptors: ReadonlyArray<ArtifactDescriptor>) => {
  const sources = descriptors
    .filter(({ kind }) => kind === "video")
    .map(
      ({ filename, mediaType }) =>
        `  <source src="./${escapeHtml(filename)}" type="${escapeHtml(mediaType)}">`,
    )
    .join("\n");
  return `<video controls preload="metadata">\n${sources}\n</video>\n`;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const ensureAuthorizationMatches = (expected: ArtifactDescriptor, actual: ArtifactDescriptor) => {
  if (
    expected.id !== actual.id ||
    expected.filename !== actual.filename ||
    expected.bytes !== actual.bytes ||
    expected.sha256 !== actual.sha256
  ) {
    throw invalidResponseError();
  }
};
