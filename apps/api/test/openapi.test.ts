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
    servers: [{ url: "https://api.densio.sh" }],
  });
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

const httpMethods = ["delete", "get", "patch", "post", "put"] as const;

const openApiDocument = async (app: Hono) =>
  (await (await app.request("/openapi.json")).json()) as OpenAPIV3_1.Document;
