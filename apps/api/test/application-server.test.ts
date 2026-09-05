import { createServer } from "node:net";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { bindApplicationServer, startApplicationServer } from "../src/http/application-server.ts";

it("holds an atomically assigned port for the server scope", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const binding = yield* bindApplicationServer("127.0.0.1", 0);
        expect(binding.port).toBeGreaterThan(0);
        const availability = yield* Effect.promise(() => portAvailability(binding.port));
        expect(availability).toBe("occupied");
      }),
    ),
  );
});

it("releases the assigned port when the server scope closes", async () => {
  const port = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const binding = yield* bindApplicationServer("127.0.0.1", 0);
        return binding.port;
      }),
    ),
  );

  expect(await portAvailability(port)).toBe("available");
});

it("removes the startup error listener after the application server is listening", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startApplicationServer("127.0.0.1", 0, () => new Response("ready"));
        if (typeof server !== "object" || !("listenerCount" in server)) {
          throw new Error("Application server did not return its listening server.");
        }
        expect(server.listenerCount("error")).toBe(0);
      }),
    ),
  );
});

const portAvailability = (port: number) =>
  new Promise<"available" | "occupied">((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve("occupied");
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error === undefined ? resolve("available") : reject(error))),
    );
  });
