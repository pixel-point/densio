import { organizationResponses } from "./organization-responses.ts";
import {
  BillingContactRequestSchema,
  CheckoutPlanRequestSchema,
  JobIdempotencyKeySchema,
  PublicCapabilitiesSchema,
  successEnvelope,
  type BillingStatus,
} from "@densio/shared";
import { Schema } from "effect";
import { CliUsageError } from "./cli-errors.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { decodeCliOptions, requireSinglePositional } from "./command-options.ts";
import { jsonRequest, requestJson } from "./http-client.ts";
import { requiredCommandFlag } from "./command-options.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

export const runCapabilitiesCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const parsed = parseCatalogCommand("capabilities", argv);
  if (parsed.positionals.length > 0)
    throw new CliUsageError("capabilities accepts no positional arguments.");
  if (parsed.switches.has("--public")) {
    if (runtime.explicitOrganizationId !== undefined)
      throw new CliUsageError("--public conflicts with --org.");
    const response = await requestJson(
      runtime,
      "/v1/capabilities",
      { method: "GET" },
      Schema.decodeUnknownEffect(successEnvelope(PublicCapabilitiesSchema)),
    );
    emitSuccess(
      runtime,
      response,
      "Public codecs, plans, and common media policy. Use capabilities --org ORG_ID for effective limits.\n",
    );
    return;
  }
  const selected = await selectOrganization(runtime);
  const response = await selected.organizationClient.request(
    organizationPath(selected, "/capabilities"),
    { method: "GET" },
    organizationResponses.Capabilities,
  );
  emitSuccess(
    selected,
    response,
    `Organization ${response.data.organizationId}; plan ${response.data.plan}; codecs ${response.data.codecs.map(({ codec }) => codec).join(", ")}.\n`,
  );
};

export const runBillingCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [command, ...rest] = argv;
  if (
    command !== "status" &&
    command !== "subscribe" &&
    command !== "portal" &&
    command !== "contact"
  )
    throw new CliUsageError(
      "billing requires status, subscribe basic|pro|scale --idempotency-key KEY, portal, or contact EMAIL.",
    );
  const parsed = parseCatalogCommand(`billing ${command}`, rest);
  if ((command === "status" || command === "portal") && parsed.positionals.length > 0)
    throw new CliUsageError(`billing ${command} accepts no arguments.`);
  const body =
    command === "subscribe"
      ? decodeCliOptions(
          CheckoutPlanRequestSchema,
          { plan: requireSinglePositional(parsed, "billing subscribe requires one paid plan.") },
          "billing subscribe basic|pro|scale",
        )
      : command === "contact"
        ? decodeCliOptions(
            BillingContactRequestSchema,
            {
              billingEmail: requireSinglePositional(
                parsed,
                "billing contact requires one email address.",
              ),
            },
            "billing contact",
          )
        : undefined;
  const key =
    command === "subscribe"
      ? decodeCliOptions(
          JobIdempotencyKeySchema,
          requiredCommandFlag(parsed, "--idempotency-key"),
          "billing subscribe",
        )
      : undefined;
  const selected = await selectOrganization(runtime);
  const headers = key === undefined ? {} : { "idempotency-key": key };
  if (command === "status") {
    const response = await selected.organizationClient.request(
      organizationPath(selected, "/billing/status"),
      { method: "GET" },
      organizationResponses.BillingStatus,
    );
    emitSuccess(selected, response, billingStatusText(response.data));
    return;
  }
  if (command === "contact") {
    const response = await selected.organizationClient.request(
      organizationPath(selected, "/billing/contact"),
      jsonRequest("PATCH", body, headers),
      organizationResponses.BillingContactResponse,
    );
    emitSuccess(selected, response, `Billing contact updated to ${response.data.billingEmail}.\n`);
    return;
  }
  const response = await selected.organizationClient.request(
    organizationPath(selected, `/billing/${command === "subscribe" ? "checkout" : "portal"}`),
    jsonRequest("POST", body, headers),
    organizationResponses.BillingSessionResponse,
  );
  emitSuccess(selected, response, `${response.data.url}\n`);
};

const billingStatusText = ({
  organizationId,
  billingEmail,
  credits,
  plan,
  renewsAt,
  subscriptionStatus,
}: BillingStatus) =>
  [
    `Organization ${organizationId}; billing contact ${billingEmail}.`,
    `${plan} plan; ${credits.available} available, ${credits.reserved} reserved, ${credits.used} used of ${credits.monthly} monthly pooled credits; resets ${credits.resetsAt}.`,
    ...(subscriptionStatus === undefined ? [] : [`subscription ${subscriptionStatus}.`]),
    ...(renewsAt === undefined ? [] : [`renews ${renewsAt}.`]),
    "",
  ].join("\n");
