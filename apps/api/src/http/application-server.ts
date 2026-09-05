import { createServer, type Server } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { serve, type ServerType } from "@hono/node-server";
import { Effect, type Scope } from "effect";

type ApplicationFetch = (request: Request) => Response | Promise<Response>;

export interface ApplicationServerBinding {
  readonly port: number;
  readonly server: Server;
}

export const bindApplicationServer = Effect.fn("ApplicationServer.bind")(function* (
  host: string,
  port: number,
): Effect.fn.Return<ApplicationServerBinding, never, Scope.Scope> {
  return yield* Effect.acquireRelease(
    Effect.callback<ApplicationServerBinding>((resume) => {
      const server = createServer();
      const fail = (error: Error) => resume(Effect.die(error));
      server.once("error", fail);
      server.listen(port, host, () => {
        server.off("error", fail);
        const address = server.address();
        if (address === null || typeof address === "string") {
          resume(Effect.die(new Error("Application server did not expose a TCP address.")));
          return;
        }
        resume(Effect.succeed({ port: address.port, server }));
      });
      return Effect.sync(() => closeServerImmediately(server));
    }),
    ({ server }) => closeServer(server),
  );
});

export const startApplicationServer = (
  host: string,
  port: number,
  fetch: ApplicationFetch,
  binding?: ApplicationServerBinding,
) => {
  if (binding !== undefined) {
    return Effect.acquireRelease(
      Effect.sync(() => {
        const listener = getRequestListener(fetch, { hostname: host });
        binding.server.on("request", listener);
        return listener;
      }),
      (listener) => Effect.sync(() => binding.server.off("request", listener)),
    );
  }

  return Effect.acquireRelease(
    Effect.callback<ServerType>((resume) => {
      const fail = (error: Error) => resume(Effect.die(error));
      const server = serve({ fetch, hostname: host, port }, () => {
        server.off("error", fail);
        resume(Effect.succeed(server));
      });
      server.once("error", fail);
      return Effect.sync(() => closeServerImmediately(server));
    }),
    closeServer,
  );
};

const closeServerImmediately = (server: ServerType) => {
  if (server.listening) server.close();
};

const closeServer = (server: ServerType) =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close((error) => resume(error === undefined ? Effect.void : Effect.die(error)));
  });
