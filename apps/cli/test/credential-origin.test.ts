import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("credential origin binding", () => {
  it("never sends bearer or refresh secrets to a different API origin", async () => {
    const credentialOrigin = await startCliServer((_request, response) => {
      response.end();
    });
    const requests: Array<{
      readonly authorization?: string;
      readonly body: string;
      readonly path: string;
    }> = [];
    const otherOrigin = await startCliServer(async (request, response) => {
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        body: (await readRequestBody(request)).toString(),
        path: request.url ?? "",
      });
      sendEnvelope(response, { authenticated: false });
    });
    const statusCapture = await makeCliCapture();
    await writeCredentials(statusCapture.dependencies.credentialsPath, {
      accessToken: "origin-a-access",
      accessTokenExpiresAt: "2026-07-11T11:00:00.000Z",
      apiUrl: credentialOrigin.url,
      refreshToken: "origin-a-refresh",
    });

    expect(
      await runCli(
        ["--json", "--api-url", otherOrigin.url, "auth", "status"],
        statusCapture.dependencies,
      ),
    ).toBe(0);
    const billingCapture = await makeCliCapture();
    await writeCredentials(billingCapture.dependencies.credentialsPath, {
      accessToken: "origin-a-access",
      accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
      apiUrl: credentialOrigin.url,
      refreshToken: "origin-a-refresh",
    });
    expect(
      await runCli(
        [
          "--json",
          "--api-url",
          otherOrigin.url,
          "billing",
          "subscribe",
          "basic",
          "--idempotency-key",
          "checkout-1",
        ],
        billingCapture.dependencies,
      ),
    ).toBe(3);
    await credentialOrigin.close();
    await otherOrigin.close();

    expect(requests).toEqual([{ body: "", path: "/v1/auth/status" }]);
    expect(`${statusCapture.stderr()}${billingCapture.stderr()}`).not.toContain("origin-a-refresh");
  });
});
