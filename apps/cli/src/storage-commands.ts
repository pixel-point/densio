import { STORAGE_COMMAND_CATALOG } from "./storage-command-catalog.ts";
import {
  StorageConnectionCreateRequestSchema,
  StorageConnectionRotateRequestSchema,
  StorageSettingsSchema,
} from "@densio/shared";
import { Schema } from "effect";
import { parseCatalogCommand } from "./command-catalog.ts";
import {
  decodeCliOptions,
  requireSinglePositional,
  singleFlag,
  requiredCommandFlag,
  idempotencyHeaders,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import { jsonRequest } from "./http-client.ts";
import {
  organizationPath,
  prepareOrganizationRequest,
  selectOrganization,
  type OrganizationRuntime,
} from "./organization-context.ts";
import { readProtectedJson } from "./protected-json-input.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { parseDestination } from "./storage-options.ts";
import { storageResponses } from "./storage-responses.ts";

export const StorageConnectionFileSchema = Schema.Struct({
  ...StorageConnectionCreateRequestSchema.fields,
  name: Schema.optionalKey(StorageConnectionCreateRequestSchema.fields.name),
});

export const runStorageCommand = async (argv: readonly string[], unscoped: CliRuntime) => {
  const [command, ...args] = argv;
  if (!isStorageCommand(command))
    throw new CliUsageError("Unknown storage command; see densio --help.");
  const parsed = parseCatalogCommand(`storage ${command}`, args);
  const execute = await prepareStorageCommand(command, parsed);
  const runtime = await selectOrganization(unscoped, undefined, {
    allowClosed: ["get", "list", "operation"].includes(command),
  });
  const response = await execute(runtime);
  emitSuccess(runtime, response, `${JSON.stringify(response.data, null, 2)}\n`);
};
type StorageCommandName = Extract<keyof typeof STORAGE_COMMAND_CATALOG, `storage ${string}`>;
type StorageCommand = StorageCommandName extends `storage ${infer Command}` ? Command : never;
const isStorageCommand = (command: string | undefined): command is StorageCommand =>
  Object.hasOwn(STORAGE_COMMAND_CATALOG, `storage ${command}`);
type Parsed = ReturnType<typeof parseCatalogCommand>;

const prepareStorageCommand = async (command: StorageCommand, parsed: Parsed) => {
  const path = "/storage";
  if (command === "connect") {
    if (parsed.positionals.length)
      throw new CliUsageError("storage connect takes --config and --name flags.");
    const config = await readProtectedJson(
      requiredCommandFlag(parsed, "--config"),
      StorageConnectionFileSchema,
    );
    const name = singleFlag(parsed, "--name") ?? config.name;
    if (!name) throw new CliUsageError("--name is required when it is absent from --config.");
    const request = decodeCliOptions(
      StorageConnectionCreateRequestSchema,
      { ...config, name },
      "storage connect",
    );
    return prepareOrganizationRequest(
      `${path}/connections`,
      jsonRequest("POST", request, idempotencyHeaders(parsed)),
      storageResponses.connectionCreated,
    );
  }
  if (["list", "settings", "usage"].includes(command)) {
    if (parsed.positionals.length)
      throw new CliUsageError(`storage ${command} takes no positional arguments.`);
    if (command === "list")
      return prepareOrganizationRequest(
        `${path}/connections`,
        { method: "GET" },
        storageResponses.connections,
      );
    if (command === "usage")
      return prepareOrganizationRequest(`${path}/usage`, { method: "GET" }, storageResponses.usage);
    return prepareOrganizationRequest(
      `${path}/settings`,
      { method: "GET" },
      storageResponses.settings,
    );
  }
  return prepareIdentifiedStorageCommand(command, parsed);
};
const prepareIdentifiedStorageCommand = async (command: StorageCommand, parsed: Parsed) => {
  const id = requireSinglePositional(parsed, `storage ${command} requires one identifier.`);
  const path = "/storage";
  if (command === "default")
    return prepareOrganizationRequest(
      `${path}/settings`,
      jsonRequest(
        "PATCH",
        decodeCliOptions(
          StorageSettingsSchema,
          {
            destination: parseDestination(id),
            visibility: singleFlag(parsed, "--visibility") ?? "public",
          },
          "storage default",
        ),
      ),
      storageResponses.settings,
    );
  if (command === "get")
    return prepareOrganizationRequest(
      `${path}/connections/${encodeURIComponent(id)}`,
      { method: "GET" },
      storageResponses.connection,
    );
  if (command === "operation")
    return prepareOrganizationRequest(
      `${path}/operations/${encodeURIComponent(id)}`,
      { method: "GET" },
      storageResponses.operation,
    );
  if (["transfer", "retry", "cancel"].includes(command)) {
    const headers = command === "transfer" ? {} : idempotencyHeaders(parsed);
    return async (runtime: OrganizationRuntime) => {
      const response = await prepareOrganizationRequest(
        `${path}/transfers/${encodeURIComponent(id)}`,
        { method: "GET" },
        storageResponses.transfer,
      )(runtime);
      if (command === "transfer") return response;
      const video = await prepareOrganizationRequest(
        `/videos/${encodeURIComponent(response.data.transfer.videoId)}`,
        { method: "GET" },
        storageResponses.video,
      )(runtime);
      if (video.data.video.transferId !== id)
        throw new CliUsageError(
          "That transfer is historical; retry or cancel the video's current transfer ID.",
        );
      return runtime.organizationClient.request(
        organizationPath(
          runtime,
          `/videos/${encodeURIComponent(response.data.transfer.videoId)}/${command}`,
        ),
        jsonRequest("POST", {}, headers),
        storageResponses.videoMutation,
      );
    };
  }
  const request =
    command === "rotate"
      ? await readProtectedJson(
          requiredCommandFlag(parsed, "--config"),
          StorageConnectionRotateRequestSchema,
        )
      : {};
  return prepareOrganizationRequest(
    `${path}/connections/${encodeURIComponent(id)}/${command === "test" ? "validate" : command}`,
    jsonRequest("POST", request, idempotencyHeaders(parsed)),
    storageResponses.operation,
  );
};
