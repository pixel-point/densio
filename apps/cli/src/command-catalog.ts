import {
  STORAGE_COMMAND_CATALOG,
  storagePlanningOptions,
  storageWaitOption,
} from "./storage-command-catalog.ts";
import { parseCommandArguments } from "./command-options.ts";

interface CommandOption {
  readonly flag: `--${string}`;
  readonly value?: string;
  readonly description: string;
}

interface CommandDefinition {
  readonly usage: string;
  readonly description: string;
  readonly options: ReadonlyArray<CommandOption>;
}

const idempotency = {
  flag: "--idempotency-key",
  value: "KEY",
  description: "Safe retry key; required for execution.",
} as const;
const force = {
  flag: "--force",
  description: "Replace local outputs with best-effort rollback backups.",
} as const;
const outputDirectory = {
  flag: "--output-dir",
  value: "DIR",
  description: "Materialize verified outputs after success.",
} as const;
const timeout = {
  flag: "--timeout",
  value: "SECONDS",
  description: "Bound polling, HTTP and token refresh; leave the server job running.",
} as const;
const clientReference = {
  flag: "--client-reference",
  value: "REF",
  description: "Organization-scoped execution recovery reference.",
} as const;
const cursor = {
  flag: "--cursor",
  value: "CURSOR",
  description: "Continue a keyset-paginated listing.",
} as const;
const limit = {
  flag: "--limit",
  value: "N",
  description: "Maximum page size, from 1 to 100.",
} as const;
const since = {
  flag: "--since",
  value: "ISO",
  description: "Filter by creation timestamp.",
} as const;
const state = {
  flag: "--state",
  value: "STATE",
  description: "Filter by current lifecycle state.",
} as const;
const guards = [
  {
    flag: "--max-credits",
    value: "N",
    description: "Refuse a quote or execution above exact credits.",
  },
  {
    flag: "--max-output-bytes",
    value: "N",
    description: "Enforce an aggregate post-encode byte ceiling.",
  },
] as const;
const transforms = [
  {
    flag: "--width",
    value: "N",
    description: "Proportional scale width; mutually exclusive with --height.",
  },
  { flag: "--height", value: "N", description: "Proportional scale height." },
  { flag: "--allow-upscale", description: "Explicitly allow scaling above source size." },
  { flag: "--crop-aspect", value: "W:H", description: "Center crop to an aspect ratio." },
  { flag: "--crop-rect", value: "W:H:X:Y", description: "Explicit crop rectangle." },
] as const;
const optionsFile = {
  flag: "--options-file",
  value: "PATH",
  description: "Workflow options JSON; excludes individual workflow option flags.",
} as const;
const planning = [idempotency, optionsFile, ...guards, ...transforms];
const role = {
  flag: "--role",
  value: "admin|member",
  description: "Non-owner organization role.",
} as const;

const trimRangeOptions = [
  {
    flag: "--trim-start",
    value: "POSITION",
    description: "Inclusive source position: frame:N (zero-based), seconds, or HH:MM:SS.mmm.",
  },
  {
    flag: "--trim-end",
    value: "POSITION",
    description: "Exclusive source position; omit for video end. Requires --trim-start.",
  },
] as const;

const BASE_COMMAND_CATALOG = {
  ...STORAGE_COMMAND_CATALOG,
  "orgs list": {
    usage: "",
    description: "List your organizations without changing context.",
    options: [state, cursor, limit],
  },
  "orgs create": {
    usage: "NAME",
    description: "Create an organization; requires a retry key and preserves your default.",
    options: [idempotency],
  },
  "orgs get": {
    usage: "ORG_ID",
    description: "Read an organization, including closure status.",
    options: [],
  },
  "orgs rename": {
    usage: "ORG_ID NAME",
    description: "Rename an organization as owner or admin.",
    options: [],
  },
  "orgs use": {
    usage: "ORG_ID",
    description: "Save local organization selection; leave server default unchanged.",
    options: [],
  },
  "orgs default": {
    usage: "ORG_ID",
    description: "Set your server-side default; leave local selection unchanged.",
    options: [],
  },
  "orgs members list": {
    usage: "",
    description: "List current organization members.",
    options: [cursor, limit],
  },
  "orgs members set-role": {
    usage: "USER_ID",
    description: "Change a non-owner role as owner.",
    options: [role],
  },
  "orgs members remove": {
    usage: "USER_ID",
    description: "Remove membership and revoke its artifact grants.",
    options: [],
  },
  "orgs leave": {
    usage: "",
    description: "Leave the selected organization; owners must transfer first.",
    options: [],
  },
  "orgs transfer-ownership": {
    usage: "USER_ID",
    description: "Transfer to a current member; the old owner becomes admin.",
    options: [],
  },
  "orgs invitations list": {
    usage: "",
    description: "List selected organization invitations.",
    options: [state, cursor, limit],
  },
  "orgs invitations create": {
    usage: "EMAIL",
    description: "Email an invitation link to accept in the browser; requires --role.",
    options: [role],
  },
  "orgs invitations revoke": {
    usage: "INVITATION_ID",
    description: "Revoke an unaccepted invitation.",
    options: [],
  },
  "invitations list": {
    usage: "",
    description: "List invitations addressed to you across organizations.",
    options: [state, cursor, limit],
  },
  "invitations accept": {
    usage: "INVITATION_ID",
    description:
      "Accept as the authenticated recipient; email links also support browser acceptance. Defaults stay unchanged.",
    options: [],
  },
  "orgs audit-events": {
    usage: "",
    description: "Read selected organization audit events as owner or admin.",
    options: [
      limit,
      { flag: "--after", value: "N", description: "Exclusive audit sequence; default 0." },
    ],
  },
  "orgs delete": {
    usage: "ORG_ID",
    description:
      "Close an organization as owner; requires exact ID confirmation and no billing/work blockers.",
    options: [
      {
        flag: "--confirm",
        value: "ORG_ID",
        description: "Must exactly match the organization being closed.",
      },
    ],
  },
  "auth login": {
    usage: "EMAIL",
    description:
      "Authenticate by opening the emailed link and confirming sign in on the Densio website.",
    options: [],
  },
  "auth status": { usage: "", description: "Inspect authentication status.", options: [] },
  "auth logout": {
    usage: "",
    description: "Revoke authentication and remove local credentials.",
    options: [],
  },
  capabilities: {
    usage: "",
    description: "Inspect codecs, defaults, limits, and available actions.",
    options: [
      { flag: "--public", description: "Anonymous common catalog only; conflicts with --org." },
    ],
  },
  inspect: {
    usage: "VIDEO",
    description: "Upload once and return trusted source inspection.",
    options: [
      idempotency,
      {
        flag: "--upload-storage",
        value: "CONNECTION_ID",
        description: "Upload directly to the connection’s private staging bucket.",
      },
    ],
  },
  "sources list": {
    usage: "",
    description: "List your uploads, including lifecycle tombstones.",
    options: [state, since, limit, cursor],
  },
  "sources get": { usage: "SOURCE_ID", description: "Inspect an uploaded source.", options: [] },
  "sources delete": {
    usage: "SOURCE_ID",
    description: "Delete uploaded bytes; keep the source tombstone.",
    options: [],
  },
  "plans create trim": {
    usage: "SOURCE_ID trim",
    description:
      "Preview one frame-accurate re-encoded clip with unchanged dimensions and cadence.",
    options: [
      ...storagePlanningOptions,
      idempotency,
      optionsFile,
      ...guards,
      ...trimRangeOptions,
      { flag: "--codec", value: "vp9|h265|av1", description: "Required single output codec." },
      { flag: "--vp9-crf", value: "N", description: "VP9 CRF." },
      { flag: "--h265-crf", value: "N", description: "H.265 CRF." },
      { flag: "--av1-crf", value: "N", description: "AV1 CRF." },
      {
        flag: "--audio",
        value: "keep|remove",
        description: "Defaults to retaining audio when present.",
      },
    ],
  },
  "plans create compress": {
    usage: "SOURCE_ID compress",
    description: "Create immutable compression intent and an exact quote.",
    options: [
      {
        flag: "--bit-depth",
        value: "8|10",
        description: "Output bit depth for every codec; API default is 8.",
      },
      ...trimRangeOptions,
      ...storagePlanningOptions,
      ...planning,
      {
        flag: "--codec",
        value: "vp9,h265,av1",
        description: "Select output codecs; defaults are resolved by the API.",
      },
      { flag: "--vp9-crf", value: "N", description: "VP9 CRF." },
      { flag: "--h265-crf", value: "N", description: "H.265 CRF." },
      { flag: "--av1-crf", value: "N", description: "AV1 CRF." },
      { flag: "--audio", value: "auto|keep|remove", description: "Audio handling policy." },
      {
        flag: "--frame-rate",
        value: "preserve|cap-30",
        description: "Choose frame-rate handling while planning.",
      },
    ],
  },
  "plans create hls": {
    usage: "SOURCE_ID hls",
    description: "Preview HEVC fMP4 VOD renditions with shared compression CRF defaults.",
    options: [
      ...storagePlanningOptions,
      idempotency,
      optionsFile,
      ...guards,
      {
        flag: "--h265-crf",
        value: "N",
        description: "H.265 CRF; omission preserves the API compression default.",
      },
      {
        flag: "--rate-control",
        value: "capped-crf|crf",
        description: "Capped CRF by default; crf removes bitrate ceilings.",
      },
      {
        flag: "--audio",
        value: "auto|keep|remove",
        description: "One shared AAC track, or silent video.",
      },
      {
        flag: "--frame-rate",
        value: "preserve|cap-30",
        description: "Choose output frame-rate policy.",
      },
    ],
  },
  "plans create extract-images": {
    usage: "SOURCE_ID extract-images",
    description: "Plan interval images packaged as a ZIP archive.",
    options: [
      ...planning,
      {
        flag: "--interval",
        value: "SECONDS",
        description: "Positive fractional extraction interval.",
      },
      { flag: "--format", value: "jpeg|png|webp", description: "Archive image format." },
    ],
  },
  "plans create compare-quality": {
    usage: "SOURCE_ID compare-quality",
    description: "Compare two to eight codec/CRF candidates on shared samples.",
    options: [
      {
        flag: "--bit-depth",
        value: "8|10",
        description: "Reference and preview bit depth; API default is 8.",
      },
      ...planning,
      {
        flag: "--matrix",
        value: "CODEC:CRF,CRF",
        description: "Repeat for a two-to-eight candidate codec matrix.",
      },
      {
        flag: "--samples",
        value: "N",
        description: "Automatically select 1–5 samples; API default is 3.",
      },
      {
        flag: "--sample",
        value: "SECONDS|TIMECODE|frame:N",
        description: "Repeat for 1–5 explicit positions; excludes --samples.",
      },
      {
        flag: "--sample-duration",
        value: "SECONDS",
        description: "Sample duration from 1 to 3; API default is 1.",
      },
      {
        flag: "--metric",
        value: "ssim,psnr",
        description: "Objective metrics; SSIM is required and defaults on.",
      },
    ],
  },
  "plans get": {
    usage: "PLAN_ID",
    description: "Read immutable intent plus current availability.",
    options: [],
  },
  "plans resolve": {
    usage: "PLAN_ID preserve|cap-30",
    description: "Create a child plan with a frame-rate decision.",
    options: [idempotency],
  },
  "plans execute": {
    usage: "PLAN_ID",
    description: "Reserve the quote, attach the source, and execute; waits by default.",
    options: [
      storageWaitOption,
      idempotency,
      ...guards,
      clientReference,
      outputDirectory,
      timeout,
      force,
      {
        flag: "--no-wait",
        description: "Return a resumable job ID immediately; excludes --output-dir.",
      },
    ],
  },
  "jobs list": {
    usage: "",
    description: "Discover recoverable jobs.",
    options: [
      state,
      since,
      limit,
      cursor,
      clientReference,
      idempotency,
      { flag: "--workflow", value: "WORKFLOW", description: "Filter by workflow." },
    ],
  },
  "jobs lookup": {
    usage: "",
    description: "Find a job by exactly one recovery selector.",
    options: [clientReference, idempotency],
  },
  "jobs events": {
    usage: "JOB_ID",
    description: "Read ordered persisted job events.",
    options: [
      limit,
      { flag: "--after", value: "N", description: "Exclusive event sequence cursor; default 0." },
    ],
  },
  "jobs watch": {
    usage: "JOB_ID",
    description: "Drain persisted events to stderr before returning terminal status.",
    options: [timeout],
  },
  "jobs get": {
    usage: "JOB_ID",
    description: "Read status, receipt, and current artifact inventory.",
    options: [],
  },
  "jobs wait": {
    usage: "JOB_ID",
    description: "Resume waiting for a job; optionally materialize outputs.",
    options: [storageWaitOption, timeout, outputDirectory, force],
  },
  "jobs cancel": { usage: "JOB_ID", description: "Cancel unfinished work.", options: [] },
  "artifacts get": {
    usage: "ARTIFACT_ID",
    description: "Read stable artifact metadata and current availability.",
    options: [],
  },
  "artifacts authorize": {
    usage: "ARTIFACT_ID",
    description: "Mint a temporary download grant.",
    options: [],
  },
  "artifacts download": {
    usage: "ARTIFACT_ID",
    description: "Download by stable ID and verify byte count and SHA-256.",
    options: [
      force,
      { flag: "--output", value: "PATH", description: "Required local destination." },
    ],
  },
  "artifacts delete": {
    usage: "ARTIFACT_ID",
    description: "Delete retained bytes and revoke access grants.",
    options: [],
  },
  "artifacts materialize": {
    usage: "JOB_ID",
    description: "Place available verified outputs in a local directory.",
    options: [outputDirectory, force],
  },
  "billing status": { usage: "", description: "Inspect credits and billing status.", options: [] },
  "billing subscribe": {
    usage: "PLAN",
    description: "Open a subscription checkout session.",
    options: [idempotency],
  },
  "billing contact": {
    usage: "EMAIL",
    description: "Update the selected organization's billing email as owner.",
    options: [],
  },
  "billing portal": { usage: "", description: "Open the billing portal.", options: [] },
  skill: {
    usage: "[PATH]",
    description: "Load SKILL.md or one reference, with a reference index and pinned CLI version.",
    options: [
      {
        flag: "--skill-version",
        value: "VERSION",
        description: "Require the original bundle version when loading a reference.",
      },
    ],
  },
} as const satisfies Readonly<Record<string, CommandDefinition>>;

const directCommand = (
  workflow: "compress" | "extract-images" | "compare-quality" | "hls" | "trim",
) => ({
  usage: `SOURCE_ID ${workflow}`,
  description: "Submit work directly with a required retry key; waits by default.",
  options: [
    ...BASE_COMMAND_CATALOG[`plans create ${workflow}`].options,
    ...BASE_COMMAND_CATALOG["plans execute"].options.filter(
      (option) =>
        !BASE_COMMAND_CATALOG[`plans create ${workflow}`].options.some(
          ({ flag }) => flag === option.flag,
        ),
    ),
  ],
});

export const COMMAND_CATALOG = {
  ...BASE_COMMAND_CATALOG,
  "jobs create trim": directCommand("trim"),
  "jobs create hls": directCommand("hls"),
  "jobs create compress": directCommand("compress"),
  "jobs create extract-images": directCommand("extract-images"),
  "jobs create compare-quality": directCommand("compare-quality"),
} as const;

export type CatalogCommand = keyof typeof COMMAND_CATALOG;

export const parseCatalogCommand = (name: CatalogCommand, argv: ReadonlyArray<string>) => {
  const definition: CommandDefinition = COMMAND_CATALOG[name];
  return parseCommandArguments(
    argv,
    new Set(
      definition.options.filter((option) => option.value !== undefined).map(({ flag }) => flag),
    ),
    new Set(
      definition.options.filter((option) => option.value === undefined).map(({ flag }) => flag),
    ),
  );
};

export const renderCommandHelp = () =>
  Object.entries(COMMAND_CATALOG)
    .map(([name, definition]) => {
      const command = name.startsWith("plans create ")
        ? "plans create"
        : name.startsWith("jobs create ")
          ? "jobs create"
          : name;
      const options: ReadonlyArray<CommandOption> = definition.options;
      return [
        `  ${command}${definition.usage === "" ? "" : ` ${definition.usage}`}`,
        `    ${definition.description}`,
        ...options.map(
          (option) =>
            `    ${option.flag}${option.value === undefined ? "" : ` ${option.value}`} — ${option.description}`,
        ),
      ].join("\n");
    })
    .join("\n\n");
