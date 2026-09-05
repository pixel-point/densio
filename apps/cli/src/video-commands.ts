import { STORAGE_COMMAND_CATALOG } from "./storage-command-catalog.ts";
import { directoryQuery } from "./organization-command-options.ts";
import {
  VideoListQuerySchema,
  VideoSaveRequestSchema,
  VideoExportRequestSchema,
  VideoRenameRequestSchema,
  VideoVisibilityRequestSchema,
} from "@densio/shared";
import { parseCatalogCommand } from "./command-catalog.ts";
import {
  decodeCliOptions,
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
} from "./organization-context.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { parseDestination } from "./storage-options.ts";
import { storageResponses } from "./storage-responses.ts";
import { downloadStoredVideo } from "./video-download.ts";

export const runVideosCommand = async (argv: readonly string[], unscoped: CliRuntime) => {
  const [command, ...args] = argv;
  if (!isVideoCommand(command))
    throw new CliUsageError("Unknown videos command; see densio --help.");
  const parsed = parseCatalogCommand(`videos ${command}`, args);
  if (command === "list") {
    const query = directoryQuery(parsed, VideoListQuerySchema, "videos list");
    const runtime = await selectOrganization(unscoped);
    const response = await runtime.organizationClient.request(
      `${organizationPath(runtime)}/videos${query}`,
      { method: "GET" },
      storageResponses.videos,
    );
    emitSuccess(
      runtime,
      response,
      response.data.videos
        .map((video) => `${video.videoId} ${video.state} ${video.displayName}`)
        .join("\n") + "\n",
    );
    return;
  }
  const [id, value, ...extra] = parsed.positionals;
  if (
    !id ||
    (["rename", "visibility"].includes(command) && !value) ||
    extra.length ||
    (!["rename", "visibility"].includes(command) && value !== undefined)
  )
    throw new CliUsageError(
      `videos ${command} requires one identifier${["rename", "visibility"].includes(command) ? " and a value" : ""}.`,
    );
  if (command === "download") {
    const output = requiredCommandFlag(parsed, "--output-dir");
    return downloadStoredVideo(
      await selectOrganization(unscoped),
      id,
      output,
      parsed.switches.has("--force"),
    );
  }
  const execute =
    command === "get" || command === "embed"
      ? prepareOrganizationRequest(
          `/videos/${encodeURIComponent(id)}`,
          { method: "GET" },
          storageResponses.video,
        )
      : prepareVideoMutation(command, id, value, parsed);
  const runtime = await selectOrganization(unscoped);
  const response = await execute(runtime);
  if (command === "embed" && !response.data.video.embedHtml)
    throw new CliUsageError("Embed HTML is available after a public video is ready.");
  emitSuccess(
    runtime,
    response,
    command === "embed"
      ? `${response.data.video.embedHtml}\n`
      : `${JSON.stringify(response.data.video, null, 2)}\n`,
  );
};
type VideoCommandName = Extract<keyof typeof STORAGE_COMMAND_CATALOG, `videos ${string}`>;
type VideoCommand = VideoCommandName extends `videos ${infer Command}` ? Command : never;
const isVideoCommand = (command: string | undefined): command is VideoCommand =>
  Object.hasOwn(STORAGE_COMMAND_CATALOG, `videos ${command}`);
const prepareVideoMutation = (
  command: VideoCommand,
  id: string,
  value: string | undefined,
  parsed: ReturnType<typeof parseCatalogCommand>,
) => {
  const path = `/videos/${encodeURIComponent(id)}`;
  if (command === "rename")
    return prepareOrganizationRequest(
      path,
      jsonRequest(
        "PATCH",
        decodeCliOptions(VideoRenameRequestSchema, { name: value }, "videos rename"),
      ),
      storageResponses.video,
    );
  const headers = idempotencyHeaders(parsed);
  if (command === "save")
    return prepareOrganizationRequest(
      "/videos",
      jsonRequest(
        "POST",
        decodeCliOptions(
          VideoSaveRequestSchema,
          {
            jobId: id,
            ...(singleFlag(parsed, "--destination")
              ? { destination: parseDestination(singleFlag(parsed, "--destination")!) }
              : {}),
            ...optionalVideoFields(parsed),
          },
          "videos save",
        ),
        headers,
      ),
      storageResponses.videoMutation,
    );
  if (command === "export") {
    const destination = parseDestination(requiredCommandFlag(parsed, "--destination"));
    if (destination.kind !== "connection")
      throw new CliUsageError("videos export requires a customer connection ID.");
    return prepareOrganizationRequest(
      `${path}/exports`,
      jsonRequest(
        "POST",
        decodeCliOptions(
          VideoExportRequestSchema,
          { connectionId: destination.connectionId, ...optionalVideoFields(parsed) },
          "videos export",
        ),
        headers,
      ),
      storageResponses.videoMutation,
    );
  }
  const body =
    command === "visibility"
      ? decodeCliOptions(VideoVisibilityRequestSchema, { visibility: value }, "videos visibility")
      : command === "delete"
        ? { deleteObjects: parsed.switches.has("--delete-objects") }
        : {};
  return prepareOrganizationRequest(
    command === "delete" ? path : `${path}/${command}`,
    jsonRequest(command === "delete" ? "DELETE" : "POST", body, headers),
    storageResponses.videoMutation,
  );
};
const optionalVideoFields = (parsed: ReturnType<typeof parseCatalogCommand>) => {
  const name = singleFlag(parsed, "--name");
  const visibility = singleFlag(parsed, "--visibility");
  return {
    ...(name === undefined ? {} : { name }),
    ...(visibility === undefined ? {} : { visibility }),
  };
};
