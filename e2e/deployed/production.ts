import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPaidPlan,
  authenticate,
  billingStatus,
  compressAndVerify,
  gmailCredentialsFromEnvironment,
  requiredEnvironment,
} from "./journey.ts";

const run = async () => {
  const environment = process.env;
  const apiUrl = requiredEnvironment(environment, "DENSIO_SYNTHETIC_API_URL");
  const email = requiredEnvironment(environment, "DENSIO_SYNTHETIC_EMAIL");
  const expectedPlan = assertPaidPlan(
    requiredEnvironment(environment, "DENSIO_SYNTHETIC_EXPECTED_PLAN"),
  );
  const directory = await mkdtemp(join(tmpdir(), "densio-production-synthetic-"));
  const credentialsPath = join(directory, "credentials.json");

  try {
    const user = await authenticate({
      apiUrl,
      credentialsPath,
      email,
      gmail: gmailCredentialsFromEnvironment(environment),
      organizationId: requiredEnvironment(environment, "DENSIO_SYNTHETIC_ORG_ID"),
    });
    const billing = await billingStatus(apiUrl, credentialsPath);
    if (billing.plan !== expectedPlan) {
      throw new Error(
        `Expected the production organization on ${expectedPlan}, received ${billing.plan}.`,
      );
    }
    const video = await compressAndVerify(apiUrl, credentialsPath, directory);
    return {
      apiUrl,
      organizationId: user.organizationId,
      email,
      plan: billing.plan,
      userId: user.id,
      video,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

try {
  process.stdout.write(`${JSON.stringify({ ok: true, result: await run() })}\n`);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${JSON.stringify({ message, ok: false })}\n`);
  process.exitCode = 1;
}
