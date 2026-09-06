import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Plan } from "@densio/shared";

import { type GmailCredentials, waitForMagicLink } from "./gmail.ts";
import {
  decodeAuthStatus,
  decodeBillingStatus,
  decodeBillingSession,
  decodeJobStatus,
  decodePreparedSource,
  decodeExecutionPlanCreated,
} from "../support/contracts.ts";
import { probeVideo, runCli, startCli, writeVideoFixture } from "../support/driver.ts";

export const requiredEnvironment = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
};

export const gmailCredentialsFromEnvironment = (
  environment: NodeJS.ProcessEnv,
): GmailCredentials => ({
  clientId: requiredEnvironment(environment, "DENSIO_SYNTHETIC_GMAIL_CLIENT_ID"),
  clientSecret: requiredEnvironment(environment, "DENSIO_SYNTHETIC_GMAIL_CLIENT_SECRET"),
  refreshToken: requiredEnvironment(environment, "DENSIO_SYNTHETIC_GMAIL_REFRESH_TOKEN"),
});

export const assertCheckoutUrl = (input: string) => {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") {
    throw new Error("Billing did not return a hosted Stripe Checkout URL.");
  }
  return input;
};

export const assertMagicLinkUrl = (input: string, apiUrl: string, websiteUrl = apiUrl) => {
  const link = new URL(input);
  const api = new URL(apiUrl);
  if (
    !(
      (link.origin === api.origin && link.pathname === "/v1/auth/confirm") ||
      (link.origin === new URL(websiteUrl).origin && link.pathname === "/auth/confirm")
    ) ||
    link.searchParams.get("token") === null
  ) {
    throw new Error("The email magic link did not target the deployment under test.");
  }
  return input;
};

export const assertStripeTestKey = (key: string) => {
  if (!key.startsWith("sk_test_")) {
    throw new Error("The staging synthetic requires a Stripe test-mode secret key.");
  }
  return key;
};

export const assertPaidPlan = (plan: string) => {
  if (plan === "basic" || plan === "pro" || plan === "scale") return plan;
  throw new Error("DENSIO_SYNTHETIC_EXPECTED_PLAN must be basic, pro, or scale.");
};

export const authenticate = async (input: {
  readonly apiUrl: string;
  readonly websiteUrl?: string;
  readonly credentialsPath: string;
  readonly email: string;
  readonly gmail: GmailCredentials;
  readonly organizationId?: string;
}) => {
  const startedAt = Date.now();
  const inbox = new AbortController();
  const login = startCli(input.apiUrl, input.credentialsPath, ["auth", "login", input.email]);
  try {
    const verificationUrl = await Promise.race([
      waitForMagicLink(input.gmail, input.email, startedAt, inbox.signal).then((link) =>
        assertMagicLinkUrl(link, input.apiUrl, input.websiteUrl),
      ),
      login.result.then((result) =>
        Promise.reject(new Error(`CLI login exited before email delivery: ${result.stderr}`)),
      ),
    ]);
    const confirmation = await fetch(new URL("/v1/auth/confirm", input.apiUrl), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: new URL(verificationUrl).searchParams.get("token") }),
    });
    if (!confirmation.ok) {
      throw new Error(`Magic-link confirmation failed with HTTP ${confirmation.status}.`);
    }
    const result = await login.result;
    if (result.code !== 0) throw new Error(`CLI login failed: ${result.stderr}`);
    const status = await authStatus(input.apiUrl, input.credentialsPath);
    const user = authenticatedUser(status);
    if (!status.authenticated) throw new Error("Expected authentication.");
    const organizationId = input.organizationId ?? status.defaultOrganizationId;
    await runCli(input.apiUrl, input.credentialsPath, ["orgs", "use", organizationId]);
    return { ...user, organizationId };
  } catch (cause) {
    inbox.abort();
    login.stop();
    await login.result.catch(() => undefined);
    throw cause;
  }
};

export const authStatus = async (apiUrl: string, credentialsPath: string) => {
  const result = await runCli(apiUrl, credentialsPath, ["auth", "status"]);
  return decodeAuthStatus(JSON.parse(result.stdout)).data;
};

export const requestCheckout = async (apiUrl: string, credentialsPath: string) => {
  const result = await runCli(apiUrl, credentialsPath, [
    "billing",
    "subscribe",
    "basic",
    "--idempotency-key",
    "synthetic-checkout-basic",
  ]);
  const session = decodeBillingSession(JSON.parse(result.stdout)).data;
  if (session.kind !== "checkout")
    throw new Error("Billing returned a portal instead of Checkout.");
  return assertCheckoutUrl(session.url);
};

export const waitForPlan = async (apiUrl: string, credentialsPath: string, expectedPlan: Plan) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const billing = await billingStatus(apiUrl, credentialsPath);
    if (billing.plan === expectedPlan) return billing;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `The selected organization did not reach the ${expectedPlan} plan within 90 seconds.`,
  );
};

export const billingStatus = async (apiUrl: string, credentialsPath: string) =>
  decodeBillingStatus(
    JSON.parse((await runCli(apiUrl, credentialsPath, ["billing", "status"])).stdout),
  ).data;

export const compressAndVerify = async (
  apiUrl: string,
  credentialsPath: string,
  directory: string,
) => {
  const sourcePath = await writeVideoFixture(directory);
  const source = decodePreparedSource(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "inspect",
          sourcePath,
          "--idempotency-key",
          `synthetic-source-${randomUUID()}`,
        ])
      ).stdout,
    ),
  ).data;
  if (source.state !== "ready") throw new Error(`Source inspection ended in ${source.state}.`);
  const plan = decodeExecutionPlanCreated(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "plans",
          "create",
          source.sourceId,
          "compress",
          "--codec",
          "av1",
          "--audio",
          "remove",
          "--frame-rate",
          "preserve",
        ])
      ).stdout,
    ),
  ).data.plan;
  if (plan.state !== "ready") throw new Error("Compression requires an unexpected decision.");
  const compressed = await runCli(
    apiUrl,
    credentialsPath,
    [
      "plans",
      "execute",
      plan.planId,
      "--idempotency-key",
      `synthetic-execute-${plan.planId}`,
      "--max-credits",
      String(plan.quote.credits),
      "--timeout",
      "300",
    ],
    360_000,
  );
  const status = decodeJobStatus(JSON.parse(compressed.stdout)).data;
  if (status.state !== "succeeded" || status.result.kind !== "compress") {
    throw new Error(`Compression did not succeed: ${status.state}.`);
  }
  const artifact = status.artifacts.find(({ codec }) => codec === "av1");
  if (artifact === undefined) throw new Error("Compression returned no AV1 artifact.");
  const outputPath = join(directory, artifact.filename);
  await runCli(apiUrl, credentialsPath, [
    "artifacts",
    "download",
    artifact.id,
    "--output",
    outputPath,
  ]);
  const probe = await probeVideo(outputPath);
  if (
    probe.codec !== "av1" ||
    probe.width !== 64 ||
    probe.height !== 64 ||
    probe.frameRate !== "4/1" ||
    !Number.isFinite(probe.durationSeconds) ||
    probe.durationSeconds <= 0
  ) {
    throw new Error(`Unexpected compressed video stream: ${JSON.stringify(probe)}.`);
  }
  await runCli(apiUrl, credentialsPath, ["artifacts", "delete", artifact.id]);
  await runCli(apiUrl, credentialsPath, ["sources", "delete", source.sourceId]);
  return { artifactBytes: artifact.bytes, jobId: status.id, ...probe };
};

const authenticatedUser = (status: ReturnType<typeof decodeAuthStatus>["data"]) => {
  if (!status.authenticated) throw new Error("The CLI session is not authenticated.");
  return status.user;
};
