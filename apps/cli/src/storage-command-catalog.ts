const idempotency = {
  flag: "--idempotency-key",
  value: "KEY",
  description: "Required replay key for this exact intent.",
} as const;
const name = {
  flag: "--name",
  value: "NAME",
  description: "Human video or connection name.",
} as const;
const visibility = {
  flag: "--visibility",
  value: "public|private",
  description: "Public by default for stored videos.",
} as const;
const destination = {
  flag: "--destination",
  value: "densio|temporary|CONNECTION_ID",
  description: "Storage destination; omission uses organization defaults.",
} as const;
const config = {
  flag: "--config",
  value: "FILE|-",
  description: "Owner-only JSON file, or stdin; never pass secret keys as flags.",
} as const;
export const storagePlanningOptions = [destination, name, visibility];
export const storageWaitOption = {
  flag: "--until",
  value: "compressed|stored",
  description: "Wait for storage by default when the plan requests it.",
} as const;
export const STORAGE_COMMAND_CATALOG = {
  "storage connect": {
    usage: "",
    description: "Connect S3-compatible storage and validate it asynchronously.",
    options: [name, config, idempotency],
  },
  "storage list": { usage: "", description: "List sanitized storage connections.", options: [] },
  "storage get": {
    usage: "CONNECTION_ID",
    description: "Read connection configuration and state.",
    options: [],
  },
  "storage test": {
    usage: "CONNECTION_ID",
    description: "Validate provider permissions and public/private delivery.",
    options: [idempotency],
  },
  "storage rotate": {
    usage: "CONNECTION_ID",
    description: "Validate and rotate credentials from protected JSON input.",
    options: [config, idempotency],
  },
  "storage disable": {
    usage: "CONNECTION_ID",
    description: "Disable new work while keeping credentials for cleanup.",
    options: [idempotency],
  },
  "storage disconnect": {
    usage: "CONNECTION_ID",
    description:
      "Erase credentials; keep completed customer videos and report cleanup obligations.",
    options: [idempotency],
  },
  "storage operation": {
    usage: "OPERATION_ID",
    description: "Read validation, rotation or disconnect progress.",
    options: [],
  },
  "storage default": {
    usage: "densio|temporary|CONNECTION_ID",
    description: "Set organization storage defaults as owner or admin.",
    options: [visibility],
  },
  "storage settings": {
    usage: "",
    description: "Read organization storage defaults.",
    options: [],
  },
  "storage usage": {
    usage: "",
    description: "Read exact used and reserved bytes and downgrade grace.",
    options: [],
  },
  "storage transfer": {
    usage: "TRANSFER_ID",
    description: "Read durable delivery progress.",
    options: [],
  },
  "storage retry": {
    usage: "TRANSFER_ID",
    description: "Retry the current transfer without re-encoding or charging credits.",
    options: [idempotency],
  },
  "storage cancel": {
    usage: "TRANSFER_ID",
    description: "Cancel a pending save and clean up its objects.",
    options: [idempotency],
  },
  "videos list": {
    usage: "",
    description: "List saved videos and storage state.",
    options: [
      { flag: "--cursor", value: "CURSOR", description: "Continue listing." },
      { flag: "--limit", value: "N", description: "Page size from 1 to 100." },
      { flag: "--state", value: "STATE", description: "Filter video state." },
    ],
  },
  "videos get": {
    usage: "VIDEO_ID",
    description: "Read saved video metadata and delivery URLs.",
    options: [],
  },
  "videos embed": {
    usage: "VIDEO_ID",
    description: "Return embed HTML for a ready public video.",
    options: [],
  },
  "videos save": {
    usage: "JOB_ID",
    description: "Save a completed compression before temporary artifacts expire.",
    options: [destination, name, visibility, idempotency],
  },
  "videos rename": {
    usage: "VIDEO_ID NAME",
    description: "Rename display metadata while preserving filenames and URLs.",
    options: [],
  },
  "videos visibility": {
    usage: "VIDEO_ID public|private",
    description: "Withdraw or republish managed video with cache invalidation.",
    options: [idempotency],
  },
  "videos export": {
    usage: "VIDEO_ID",
    description: "Copy a saved video into customer storage without re-encoding.",
    options: [destination, visibility, idempotency],
  },
  "videos delete": {
    usage: "VIDEO_ID",
    description: "Delete saved objects and withdraw managed public delivery.",
    options: [
      idempotency,
      {
        flag: "--delete-objects",
        description: "Required confirmation for deleting customer-owned objects.",
      },
    ],
  },
  "videos forget": {
    usage: "VIDEO_ID",
    description: "Forget a customer video while retaining its remote objects.",
    options: [idempotency],
  },
  "videos retry": {
    usage: "VIDEO_ID",
    description: "Resume delivery under its original recovery deadline.",
    options: [idempotency],
  },
  "videos cancel": {
    usage: "VIDEO_ID",
    description: "Cancel delivery and clean up incomplete output.",
    options: [idempotency],
  },
  "videos download": {
    usage: "VIDEO_ID",
    description: "Download all stored variants and verify bytes and SHA-256.",
    options: [
      { flag: "--output-dir", value: "DIR", description: "Destination directory." },
      { flag: "--force", description: "Replace existing local output files." },
    ],
  },
} as const;
