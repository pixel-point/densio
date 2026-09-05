import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { requestJson } from "../src/http-client.ts";
import { pollUntilComplete } from "../src/polling.ts";
import { makeCliRuntime } from "../src/runtime.ts";

it.each(["headers", "body"])(
  "bounds a stalled response %s by the polling deadline",
  async (phase) => {
    const controller = new AbortController();
    const server = createServer((_request, response) => {
      if (phase === "body") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('"');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    const runtime = makeCliRuntime(
      {
        apiUrl: `http://127.0.0.1:${address.port}`,
        credentialsPath: "/unused/poll-test",
        json: true,
      },
      { signal: controller.signal },
    );
    const result = pollUntilComplete({
      runtime,
      deadlineAt: Date.now() + 50,
      initialDelayMilliseconds: 0,
      interruptedError: () => new Error("interrupted"),
      timeoutError: () => new Error("deadline"),
      isRetryableFailure: () => false,
      poll: (signal?: AbortSignal) =>
        requestJson(
          runtime,
          "/",
          { signal: signal ?? controller.signal },
          Schema.decodeUnknownEffect(Schema.String),
        ),
      decide: (value) => ({ kind: "complete", value }),
    }).then(
      () => "completed",
      (error: Error) => error.message,
    );
    const observed = await Promise.race([result, setTimeout(300, "still pending")]);
    controller.abort();
    await result;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(observed).toBe("deadline");
  },
);

it("does not accept a result returned after the deadline", async () => {
  let now = 0;
  await expect(
    pollUntilComplete({
      runtime: { now: () => now, sleep: async () => undefined },
      deadlineAt: 10,
      initialDelayMilliseconds: 0,
      interruptedError: () => new Error("interrupted"),
      timeoutError: () => new Error("deadline"),
      isRetryableFailure: () => false,
      poll: async () => {
        now = 11;
        return "late";
      },
      decide: (value) => ({ kind: "complete", value }),
    }),
  ).rejects.toThrow("deadline");
});
