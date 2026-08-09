import type { OpenAPIV3_1 } from "openapi-types";
import { Effect } from "effect";
import { Hono } from "hono";
import { expect, it } from "vitest";

import { createApp } from "../src/app.ts";
import { createArtifactRoutes } from "../src/routes/artifacts.ts";
import { createAuthRoutes } from "../src/routes/auth.ts";
import { createBillingRoutes } from "../src/routes/billing.ts";
import { createCapabilitiesRoutes } from "../src/routes/capabilities.ts";
import { registerDocumentationRoutes } from "../src/routes/documentation.ts";
import { createHealthRoutes } from "../src/routes/health.ts";
import { createMediaJobRoutes } from "../src/routes/media-jobs.ts";

it("serves the generated OpenAPI document", async () => {
  const response = await createApp().request("/openapi.json");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    info: { title: "Densio API", version: "1.0.0" },
    openapi: "3.1.0",
  });
  expect((await openApiDocument(createApp())).servers).toBeUndefined();
});

it("serves a non-interactive Scalar reference with a scoped CSP", async () => {
  const app = createApp();
  const response = await app.request("/docs");

  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toMatch(
    /^default-src 'none'; script-src 'nonce-[^']+' https:\/\/cdn\.jsdelivr\.net/,
  );
  const html = await response.text();
  expect(html).toContain('"url": "/openapi.json"');
  expect(html).toContain('"hideTestRequestButton": true');
  expect(html).toContain("@scalar/api-reference@1.63.0");

  const health = await app.request("/health");
  expect(health.headers.get("content-security-policy")).toBe(
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
});

it("documents every registered API operation", async () => {
  const app = createContractApp();
  const response = await app.request("/openapi.json");
  const document = (await response.json()) as OpenAPIV3_1.Document;

  expect(documentedOperations(document)).toEqual(runtimeApiOperations(app));
  expect(documentedOperations(document)).toHaveLength(20);
});

it("documents the exact response status set for every operation", async () => {
  const document = await openApiDocument(createContractApp());

  expect(documentedResponseStatuses(document)).toEqual({
    "GET /health": ["200"],
    "GET /ready": ["200", "503"],
    "GET /v1/artifacts/{artifactId}/{token}/{filename}": ["200", "206", "304", "404", "416", "500"],
    "GET /v1/auth/confirm": ["200", "400", "409", "410", "500"],
    "GET /v1/auth/status": ["200", "401", "500"],
    "GET /v1/billing/status": ["200", "401", "404", "500"],
    "GET /v1/capabilities": ["200", "401", "404", "500"],
    "GET /v1/jobs/{id}": ["200", "401", "404", "500"],
    "POST /v1/auth/login": ["202", "400", "413", "429", "500"],
    "POST /v1/auth/logout": ["200", "401", "500"],
    "POST /v1/auth/poll": ["200", "400", "409", "410", "413", "500"],
    "POST /v1/auth/refresh": ["200", "400", "401", "413", "500"],
    "POST /v1/billing/checkout": ["201", "400", "401", "404", "413", "500", "502"],
    "POST /v1/billing/portal": ["201", "401", "404", "409", "500", "502"],
    "POST /v1/billing/webhook": ["200", "400", "500", "502", "503"],
    "POST /v1/compare-quality": ["201", "400", "401", "402", "404", "409", "413", "500"],
    "POST /v1/compress": ["201", "400", "401", "402", "404", "409", "413", "500"],
    "POST /v1/extract-images": ["201", "400", "401", "402", "404", "409", "413", "500"],
    "POST /v1/jobs/{id}/cancel": ["200", "401", "404", "500"],
    "PUT /v1/jobs/{id}/upload": ["200", "400", "401", "404", "409", "410", "413", "500"],
  });
});

it("describes structured, authenticated, binary, and signed requests", async () => {
  const document = await openApiDocument(createContractApp());
  const paths = document.paths ?? {};

  expect(paths["/v1/compress"]?.post).toMatchObject({
    parameters: [{ in: "header", name: "idempotency-key", required: false }],
    requestBody: {
      content: {
        "application/json": {
          schema: {
            properties: { options: expect.any(Object), source: expect.any(Object) },
            required: ["source"],
            type: "object",
          },
        },
      },
      required: true,
    },
    security: [{ bearerAuth: [] }],
  });
  expect(paths["/v1/auth/confirm"]?.get?.parameters).toEqual([
    expect.objectContaining({ in: "query", name: "token", required: true }),
  ]);
  expect(paths["/v1/billing/webhook"]?.post?.parameters).toEqual([
    expect.objectContaining({ in: "header", name: "stripe-signature", required: true }),
  ]);
  expect(paths["/v1/jobs/{id}/upload"]?.put).toMatchObject({
    requestBody: {
      content: {
        "application/octet-stream": { schema: { format: "binary", type: "string" } },
      },
    },
    security: [{ bearerAuth: [] }],
  });
  expect(paths["/v1/artifacts/{artifactId}/{token}/{filename}"]?.get).toMatchObject({
    parameters: expect.arrayContaining([
      expect.objectContaining({ in: "path", name: "artifactId", required: true }),
      expect.objectContaining({ in: "path", name: "token", required: true }),
      expect.objectContaining({ in: "header", name: "range", required: false }),
    ]),
    responses: {
      "200": expect.any(Object),
      "206": expect.any(Object),
      "304": expect.any(Object),
    },
  });
});

const createContractApp = () => {
  const app = new Hono();
  app.route(
    "/",
    createHealthRoutes(() =>
      Effect.succeed({
        ffmpegVersion: "test",
        ffprobeVersion: "test",
        status: "ready" as const,
      }),
    ),
  );
  app.route("/", createAuthRoutes(undefined as never));
  app.route("/", createBillingRoutes(undefined as never));
  app.route("/", createMediaJobRoutes(undefined as never));
  app.route("/", createArtifactRoutes(undefined as never));
  app.route("/", createCapabilitiesRoutes(undefined as never));
  registerDocumentationRoutes(app);
  return app;
};

const runtimeApiOperations = (app: Hono) =>
  [
    ...new Set(
      app.routes
        .filter(
          ({ method, path }) => method !== "ALL" && path !== "/docs" && path !== "/openapi.json",
        )
        .map(({ method, path }) => `${method} ${path.replace(/:([^/]+)/g, "{$1}")}`),
    ),
  ].toSorted();

const documentedOperations = (document: OpenAPIV3_1.Document) =>
  Object.entries(document.paths ?? {})
    .flatMap(([path, item]) =>
      httpMethods.flatMap((method) =>
        item?.[method] === undefined ? [] : [`${method.toUpperCase()} ${path}`],
      ),
    )
    .toSorted();

const documentedResponseStatuses = (document: OpenAPIV3_1.Document) =>
  Object.fromEntries(
    Object.entries(document.paths ?? {})
      .flatMap(([path, item]) =>
        httpMethods.flatMap((method) => {
          const operation = item?.[method];
          return operation === undefined
            ? []
            : [
                [
                  `${method.toUpperCase()} ${path}`,
                  Object.keys(operation.responses).toSorted(),
                ] as const,
              ];
        }),
      )
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );

const httpMethods = ["delete", "get", "patch", "post", "put"] as const;

const openApiDocument = async (app: Hono) =>
  (await (await app.request("/openapi.json")).json()) as OpenAPIV3_1.Document;
