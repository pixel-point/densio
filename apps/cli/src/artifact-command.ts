import { organizationResponses } from "./organization-responses.ts";
import type { OrganizationRuntime } from "./organization-context.ts";

import { stageVerifiedArtifact } from "./artifact-download.ts";
import { publishVerifiedArtifact } from "./local-output.ts";
import { materializeJobArtifacts } from "./artifact-materializer.ts";
import { requireSinglePositional, singleFlag } from "./command-options.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { CliUsageError } from "./cli-errors.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";

const decodeDescriptor = organizationResponses.ArtifactDescriptor;
const decodeAuthorization = organizationResponses.ArtifactAuthorization;
const decodeDeletion = organizationResponses.ArtifactDeletedResponse;

export const runArtifactCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [command, ...argumentsRemaining] = argv;
  if (command === "get" || command === "authorize" || command === "delete") {
    await runArtifactControl(command, argumentsRemaining, runtime);
    return;
  }
  if (command === "download") {
    await runArtifactDownload(argumentsRemaining, runtime);
    return;
  }
  if (command === "materialize") {
    const parsed = parseCatalogCommand("artifacts materialize", argumentsRemaining);
    const jobId = requireSinglePositional(parsed, "artifacts materialize requires one job ID.");
    const outputDirectory = requiredFlag(parsed, "--output-dir");
    const selected = await selectOrganization(runtime);
    const response = await materializeJobArtifacts(
      selected,
      jobId,
      outputDirectory,
      parsed.switches.has("--force"),
    );
    emitSuccess(
      runtime,
      response,
      `Materialized ${response.data.files.length} artifacts in ${response.data.outputDirectory}.\n`,
    );
    return;
  }
  throw new CliUsageError("artifacts requires get, authorize, download, delete, or materialize.");
};

export const authorizeArtifact = async (runtime: OrganizationRuntime, artifactId: string) => {
  return runtime.organizationClient.request(
    `${organizationPath(runtime)}/artifacts/${encodeURIComponent(artifactId)}/authorize`,
    { method: "POST" },
    decodeAuthorization,
  );
};

const runArtifactControl = async (
  command: "get" | "authorize" | "delete",
  argv: ReadonlyArray<string>,
  unscopedRuntime: CliRuntime,
) => {
  const parsed = parseCatalogCommand(`artifacts ${command}`, argv);
  const artifactId = requireSinglePositional(
    parsed,
    `artifacts ${command} requires one artifact ID.`,
  );
  const runtime = await selectOrganization(unscopedRuntime);
  const path = `${organizationPath(runtime)}/artifacts/${encodeURIComponent(artifactId)}${command === "authorize" ? "/authorize" : ""}`;
  if (command === "get") {
    const response = await runtime.organizationClient.request(
      path,
      { method: "GET" },
      decodeDescriptor,
    );
    emitSuccess(runtime, response, artifactControlText(command, response.data));
    return;
  }
  if (command === "authorize") {
    const response = await runtime.organizationClient.request(
      path,
      { method: "POST" },
      decodeAuthorization,
    );
    emitSuccess(runtime, response, artifactControlText(command, response.data));
    return;
  }
  const response = await runtime.organizationClient.request(
    path,
    { method: "DELETE" },
    decodeDeletion,
  );
  emitSuccess(runtime, response, artifactControlText(command, response.data));
};

const runArtifactDownload = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("artifacts download", argv);
  const artifact = requireSinglePositional(parsed, "artifacts download requires one artifact ID.");
  const outputPath = requiredFlag(parsed, "--output");
  if (URL.canParse(artifact))
    throw new CliUsageError("Download requires a stable artifact ID, not a URL.");
  const runtime = await selectOrganization(unscopedRuntime);
  const authorization = await authorizeArtifact(runtime, artifact);
  const expectation = {
    bytes: authorization.data.artifact.bytes,
    sha256: authorization.data.artifact.sha256,
  };
  const downloadUrl = authorization.data.download.url;
  const downloaded = await stageVerifiedArtifact(runtime, downloadUrl, outputPath, expectation);
  await publishVerifiedArtifact(
    downloaded.temporaryPath,
    outputPath,
    parsed.switches.has("--force"),
  );
  const artifactId = authorization.data.artifact.id;
  emitSuccess(
    runtime,
    {
      correlationId: authorization.correlationId,
      data: {
        artifactId,
        organizationId: authorization.data.organizationId,
        bytes: downloaded.bytes,
        path: outputPath,
        sha256: downloaded.sha256,
        verified: true as const,
      },
      ok: true,
      schemaVersion: 1,
    },
    `Downloaded ${outputPath} (${downloaded.bytes} bytes).\n`,
  );
};

const artifactControlText = (command: string, data: unknown) => {
  if (command === "delete") return "Artifact deleted.\n";
  if (command === "authorize") return "Artifact download authorized.\n";
  if (typeof data === "object" && data !== null && "filename" in data) {
    return `${String(data.filename)}\n`;
  }
  return "Artifact found.\n";
};

const requiredFlag = (parsed: Parameters<typeof singleFlag>[0], name: string) => {
  const value = singleFlag(parsed, name);
  if (value === undefined) throw new CliUsageError(`${name} is required.`);
  return value;
};
