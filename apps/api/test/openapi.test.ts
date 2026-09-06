import type { OpenAPIV3_1 } from "openapi-types";
import {
  ExecutionPlanCreateRequestSchema,
  ExecutionPlanExecuteRequestSchema,
  ExecutionPlanResolveRequestSchema,
  JobStateSchema,
  JobWorkflowSchema,
  PreparedSourceCreateRequestSchema,
  PreparedSourceStateSchema,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { expect, it } from "vitest";

import { createOrganizationRoutes } from "../src/routes/organizations.ts";
import { createOrganizationInvitationRoutes } from "../src/routes/organization-invitations.ts";
import { createOrganizationDeletionRoutes } from "../src/routes/organization-deletion.ts";
import { createApp } from "../src/app.ts";
import { createArtifactRoutes } from "../src/routes/artifacts.ts";
import { createArtifactControlRoutes } from "../src/routes/artifact-control.ts";
import { createAuthRoutes } from "../src/routes/auth.ts";
import { createBillingRoutes } from "../src/routes/billing.ts";
import { createCapabilitiesRoutes } from "../src/routes/capabilities.ts";
import { registerDocumentationRoutes } from "../src/routes/documentation.ts";
import { createHealthRoutes } from "../src/routes/health.ts";
import { createMediaJobRoutes } from "../src/routes/media-jobs.ts";
import { createExecutionPlanRoutes } from "../src/routes/execution-plans.ts";
import { createSkillRoutes } from "../src/routes/skill.ts";
import { createSourceRoutes } from "../src/routes/sources.ts";

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
  expect(documentedOperations(document)).toHaveLength(59);
});

it("documents the exact response status set for every operation", async () => {
  const document = await openApiDocument(createContractApp());

  expect(documentedResponseStatuses(document)).toEqual(expectedOperationStatuses);
});

it("documents the required live artifact inventory on succeeded job status", async () => {
  const succeeded = succeededJobStatusSchema(await openApiDocument(createContractApp()));

  expect(succeeded).toMatchObject({
    properties: {
      artifacts: {
        items: {
          properties: {
            availability: { enum: ["available", "deleted", "expired"] },
          },
          required: expect.arrayContaining([
            "id",
            "availability",
            "retainedUntil",
            "authorizeUrl",
            "deleteUrl",
          ]),
        },
        type: "array",
      },
      receipt: {
        properties: {
          execution: expect.any(Object),
          intent: expect.any(Object),
          source: expect.any(Object),
        },
        required: expect.arrayContaining(["source", "intent", "execution", "billing", "artifacts"]),
        type: "object",
      },
    },
    required: expect.arrayContaining(["artifacts", "result", "receipt"]),
  });
});

it("describes structured, authenticated, binary, and signed requests", async () => {
  const document = await openApiDocument(createContractApp());
  const paths = document.paths ?? {};

  expect(paths["/v1/organizations/{organizationId}/sources"]?.post).toMatchObject({
    parameters: expect.arrayContaining([
      expect.objectContaining({ in: "header", name: "idempotency-key", required: false }),
    ]),
    requestBody: {
      content: {
        "application/json": {
          schema: {
            properties: { filename: expect.any(Object), bytes: expect.any(Object) },
            required: ["filename", "bytes"],
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
  expect(paths["/v1/organization-invitations/confirm"]?.get).toMatchObject({
    parameters: [expect.objectContaining({ in: "query", name: "token", required: true })],
    security: [],
  });
  expect(paths["/v1/organization-invitations/confirm"]?.post).toMatchObject({
    requestBody: {
      required: true,
      content: { "application/x-www-form-urlencoded": { schema: { required: ["token"] } } },
    },
    responses: { "303": { description: expect.any(String) } },
    security: [],
  });
  expect(paths["/v1/billing/webhook"]?.post?.parameters).toEqual([
    expect.objectContaining({ in: "header", name: "stripe-signature", required: true }),
  ]);
  expect(paths["/v1/organizations/{organizationId}/sources/{id}/upload"]?.put).toMatchObject({
    requestBody: {
      content: {
        "application/octet-stream": { schema: { format: "binary", type: "string" } },
      },
    },
    security: [{ bearerAuth: [] }],
  });
  expect(
    paths["/v1/organizations/{organizationId}/execution-plans/{id}/resolve"]?.post,
  ).toMatchObject({
    requestBody: {
      content: {
        "application/json": {
          schema: { required: ["frameRate"], type: "object" },
        },
      },
      required: true,
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

it("introduces the agent workflow and documents every tag", async () => {
  const document = await openApiDocument(createContractApp());

  expect(document.info.description).toContain("Upload → submit → observe → download");
  expect(document.info.description).toContain("application/problem+json");
  expect(document.info.description).toContain("/v1/skill");
  expect(document.info.description).toContain("subscription evidence commit atomically");
  expect(document.info.description).toContain("Contact retries reconcile the same saved email");
  expect(document.info.description).toContain("Physical cleanup waits for active writers");
  const tags = Object.values(document.paths ?? {}).flatMap((path) =>
    httpMethods.flatMap((method) => path?.[method]?.tags ?? []),
  );
  expect(document.tags?.map(({ name }) => name).toSorted()).toEqual([...new Set(tags)].toSorted());
  document.tags?.forEach((tag) => expect(tag.description).toBeTruthy());
});

it("documents artifact media streams and revoked download grants", async () => {
  const document = await openApiDocument(createContractApp());
  const responses =
    document.paths?.["/v1/artifacts/{artifactId}/{token}/{filename}"]?.get?.responses;
  ["200", "206"].forEach((status) => {
    expect(responses?.[status]).toMatchObject({
      content: { "*/*": { schema: { format: "binary", type: "string" } } },
    });
  });
  expect(responses?.["404"]).toMatchObject({ description: expect.stringContaining("revoked") });
});

it.each([
  [
    "/v1/organizations/{organizationId}/sources",
    "state",
    { enum: PreparedSourceStateSchema.literals, type: "string" },
  ],
  [
    "/v1/organizations/{organizationId}/jobs",
    "state",
    { enum: JobStateSchema.literals, type: "string" },
  ],
  [
    "/v1/organizations/{organizationId}/jobs",
    "workflow",
    { enum: JobWorkflowSchema.literals, type: "string" },
  ],
  [
    "/v1/organizations/{organizationId}/sources",
    "limit",
    { type: "integer", allOf: [{ minimum: 1, maximum: 100 }] },
  ],
  [
    "/v1/organizations/{organizationId}/jobs",
    "limit",
    { type: "integer", allOf: [{ minimum: 1, maximum: 100 }] },
  ],
  [
    "/v1/organizations/{organizationId}/jobs/{id}/events",
    "limit",
    { type: "integer", allOf: [{ minimum: 1, maximum: 100 }] },
  ],
  [
    "/v1/organizations/{organizationId}/jobs/{id}/events",
    "after",
    { type: "integer", allOf: [{ minimum: 0 }] },
  ],
  [
    "/v1/organizations/{organizationId}/sources",
    "cursor",
    { type: "string", allOf: [{ minLength: 1 }, { maxLength: 2_000 }] },
  ],
  [
    "/v1/organizations/{organizationId}/jobs",
    "cursor",
    { type: "string", allOf: [{ minLength: 1 }, { maxLength: 2_000 }] },
  ],
  [
    "/v1/organizations/{organizationId}/jobs/lookup",
    "clientReference",
    { type: "string", allOf: [{ minLength: 1 }, { maxLength: 200 }] },
  ],
  [
    "/v1/organizations/{organizationId}/jobs/lookup",
    "idempotencyKey",
    { type: "string", allOf: [{ minLength: 1 }, { maxLength: 200 }] },
  ],
] as const)("documents the validated %s %s query schema", async (path, name, schema) => {
  const document = await openApiDocument(createContractApp());
  expect(document.paths?.[path]?.get?.parameters).toContainEqual(
    expect.objectContaining({
      in: "query",
      name,
      required: false,
      schema: expect.objectContaining(schema),
    }),
  );
});

it.each([
  ["/v1/organizations/{organizationId}/sources", false],
  ["/v1/organizations/{organizationId}/execution-plans", false],
  ["/v1/organizations/{organizationId}/execution-plans/{id}/resolve", false],
  ["/v1/organizations/{organizationId}/execution-plans/{id}/execute", true],
] as const)("documents the %s retry key constraints", async (path, required) => {
  const document = await openApiDocument(createContractApp());
  expect(document.paths?.[path]?.post?.parameters).toContainEqual(
    expect.objectContaining({
      in: "header",
      name: "idempotency-key",
      required,
      schema: expect.objectContaining({
        type: "string",
        allOf: [{ minLength: 1 }, { maxLength: 200 }],
      }),
    }),
  );
});

it.each([
  ["/v1/organizations/{organizationId}/sources", PreparedSourceCreateRequestSchema, ["upload"]],
  [
    "/v1/organizations/{organizationId}/execution-plans",
    ExecutionPlanCreateRequestSchema,
    ["compress", "compress10Bit", "extractImages", "compareQuality", "singleSample", "trim"],
  ],
  [
    "/v1/organizations/{organizationId}/execution-plans/{id}/resolve",
    ExecutionPlanResolveRequestSchema,
    ["cap", "preserve"],
  ],
  [
    "/v1/organizations/{organizationId}/execution-plans/{id}/execute",
    ExecutionPlanExecuteRequestSchema,
    ["execute", "guarded"],
  ],
] as const)("publishes contract-valid request examples for %s", async (path, schema, names) => {
  const document = await openApiDocument(createContractApp());
  const body = document.paths?.[path]?.post?.requestBody as OpenAPIV3_1.RequestBodyObject;
  const examples = body.content["application/json"]?.examples;
  expect(Object.keys(examples ?? {}).toSorted()).toEqual([...names].toSorted());
  Object.values(examples ?? {}).forEach((example) => {
    expect("value" in example).toBe(true);
    if ("value" in example) {
      expect(
        Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(example.value),
      ).toEqual(example.value);
    }
  });
});

it.each([
  [
    "/v1/organizations/{organizationId}/sources/{id}",
    "delete",
    ["already-attached", "cleanup", "deleted"],
  ],
  [
    "/v1/organizations/{organizationId}/execution-plans",
    "post",
    ["does not reserve credits", "1–5", "2–8", "SSIM", "video-only"],
  ],
  ["/v1/organizations/{organizationId}/execution-plans/{id}", "get", ["availability", "immutable"]],
  [
    "/v1/organizations/{organizationId}/execution-plans/{id}/resolve",
    "post",
    ["new", "immutable", "frame-rate"],
  ],
  [
    "/v1/organizations/{organizationId}/execution-plans/{id}/execute",
    "post",
    ["preparing", "maxCredits", "maxOutputBytes", "charged", "expiry"],
  ],
  [
    "/v1/organizations/{organizationId}/jobs/{id}",
    "get",
    ["receipt", "progress", "artifacts", "immutable"],
  ],
  ["/v1/organizations/{organizationId}/jobs/lookup", "get", ["exactly one"]],
  ["/v1/organizations/{organizationId}/jobs/{id}/events", "get", ["JSON", "nextCursor", "after"]],
  [
    "/v1/organizations/{organizationId}/artifacts/{artifactId}",
    "get",
    ["deleted", "expired", "200"],
  ],
  [
    "/v1/organizations/{organizationId}/artifacts/{artifactId}",
    "delete",
    ["revokes", "cleanup", "receipt"],
  ],
  [
    "/v1/organizations/{organizationId}/artifacts/{artifactId}/authorize",
    "post",
    ["retention", "404", "410"],
  ],
] as const)("explains %s %s lifecycle semantics", async (path, method, concepts) => {
  const document = await openApiDocument(createContractApp());
  const description = document.paths?.[path]?.[method]?.description ?? "";
  concepts.forEach((concept) => expect(description).toContain(concept));
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
  app.route("/", createOrganizationRoutes(undefined as never));
  app.route("/", createOrganizationInvitationRoutes(undefined as never));
  app.route("/", createOrganizationDeletionRoutes(undefined as never));
  app.route("/", createAuthRoutes(undefined as never));
  app.route("/", createBillingRoutes(undefined as never));
  app.route("/", createMediaJobRoutes(undefined as never));
  app.route("/", createExecutionPlanRoutes(undefined as never));
  app.route("/", createSourceRoutes(undefined as never));
  app.route("/", createArtifactRoutes(undefined as never));
  app.route("/", createArtifactControlRoutes(undefined as never));
  app.route("/", createCapabilitiesRoutes(undefined as never));
  app.route(
    "/",
    createSkillRoutes({
      bundle: {
        entrypoint: "SKILL.md",
        files: [{ content: "# Densio\n", path: "SKILL.md", sha256: "a".repeat(64) }],
        skillVersion: `sha256:${"b".repeat(64)}`,
      },
      createCorrelationId: () => "openapi-skill",
    }),
  );
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

interface OpenApiSchemaNode {
  readonly anyOf?: ReadonlyArray<OpenApiSchemaNode>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly items?: OpenApiSchemaNode;
  readonly properties?: Readonly<Record<string, OpenApiSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly type?: string;
}

const succeededJobStatusSchema = (document: OpenAPIV3_1.Document) => {
  const response =
    document.paths?.["/v1/organizations/{organizationId}/jobs/{id}"]?.get?.responses["200"];
  const schema = (response as OpenAPIV3_1.ResponseObject | undefined)?.content?.["application/json"]
    ?.schema as OpenApiSchemaNode | undefined;
  return schema?.properties?.data?.anyOf?.find(({ properties }) =>
    properties?.state?.enum?.includes("succeeded"),
  );
};

const httpMethods = ["delete", "get", "patch", "post", "put"] as const;

const openApiDocument = async (app: Hono) =>
  (await (await app.request("/openapi.json")).json()) as OpenAPIV3_1.Document;

const expectedOperationStatuses = {
  "DELETE /v1/organizations/{organizationId}": [
    "200",
    "202",
    "401",
    "403",
    "404",
    "409",
    "500",
    "502",
    "503",
  ],
  "DELETE /v1/organizations/{organizationId}/artifacts/{artifactId}": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "DELETE /v1/organizations/{organizationId}/invitations/{invitationId}": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "DELETE /v1/organizations/{organizationId}/members/{userId}": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "DELETE /v1/organizations/{organizationId}/sources/{id}": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /health": ["200"],
  "GET /ready": ["200", "503"],
  "GET /v1/artifacts/{artifactId}/{token}/{filename}": ["200", "206", "304", "404", "416", "500"],
  "GET /v1/auth/confirm": ["303"],
  "POST /v1/auth/confirm": ["200", "400", "409", "410", "413", "500"],
  "POST /v1/auth/browser/confirm": ["200", "400", "409", "410", "413", "500"],
  "POST /v1/auth/browser/poll": ["200", "400", "409", "410", "413", "500"],
  "GET /v1/auth/status": ["200", "401", "500"],
  "GET /v1/capabilities": ["200", "500"],
  "GET /v1/organization-invitations": ["200", "400", "401", "500"],
  "GET /v1/organization-invitations/confirm": ["303"],
  "GET /v1/organization-invitations/link": ["200", "400", "404", "409", "410", "500"],
  "GET /v1/organizations": ["200", "400", "401", "500"],
  "GET /v1/organizations/{organizationId}": ["200", "401", "404", "500"],
  "GET /v1/organizations/{organizationId}/artifacts/{artifactId}": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/audit-events": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/billing/status": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/capabilities": ["200", "401", "403", "404", "409", "500"],
  "GET /v1/organizations/{organizationId}/execution-plans/{id}": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/invitations": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/jobs": ["200", "400", "401", "403", "404", "409", "500"],
  "GET /v1/organizations/{organizationId}/jobs/lookup": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/jobs/{id}": ["200", "401", "403", "404", "409", "500"],
  "GET /v1/organizations/{organizationId}/jobs/{id}/events": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/members": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/sources": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "GET /v1/organizations/{organizationId}/sources/{id}": ["200", "401", "403", "404", "409", "500"],
  "GET /v1/skill": ["200"],
  "PATCH /v1/organizations/{organizationId}": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "500",
  ],
  "PATCH /v1/organizations/{organizationId}/billing/contact": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "500",
    "502",
  ],
  "PATCH /v1/organizations/{organizationId}/members/{userId}": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "500",
  ],
  "POST /v1/auth/login": ["202", "400", "413", "429", "500"],
  "POST /v1/auth/logout": ["200", "401", "500"],
  "POST /v1/auth/poll": ["200", "400", "409", "410", "413", "500"],
  "POST /v1/auth/refresh": ["200", "400", "401", "413", "500"],
  "POST /v1/billing/webhook": ["200", "400", "500", "502", "503"],
  "POST /v1/organization-invitations/confirm": ["303", "400", "404", "409", "410", "413", "500"],
  "POST /v1/organization-invitations/link": ["200", "400", "404", "409", "410", "413", "500"],
  "POST /v1/organization-invitations/{invitationId}/accept": [
    "200",
    "401",
    "404",
    "409",
    "410",
    "500",
  ],
  "POST /v1/organizations": ["200", "201", "400", "401", "404", "409", "413", "429", "500"],
  "POST /v1/organizations/{organizationId}/artifacts/{artifactId}/authorize": [
    "201",
    "401",
    "403",
    "404",
    "409",
    "410",
    "500",
  ],
  "POST /v1/organizations/{organizationId}/billing/checkout": [
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "500",
    "502",
    "503",
  ],
  "POST /v1/organizations/{organizationId}/billing/portal": [
    "201",
    "401",
    "403",
    "404",
    "409",
    "500",
    "502",
  ],
  "POST /v1/organizations/{organizationId}/jobs": [
    "200",
    "201",
    "400",
    "401",
    "402",
    "403",
    "404",
    "409",
    "410",
    "412",
    "413",
    "422",
    "429",
    "500",
    "503",
  ],
  "POST /v1/organizations/{organizationId}/execution-plans": [
    "200",
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "410",
    "412",
    "413",
    "422",
    "429",
    "500",
    "503",
  ],
  "POST /v1/organizations/{organizationId}/execution-plans/{id}/execute": [
    "200",
    "201",
    "400",
    "401",
    "402",
    "403",
    "404",
    "409",
    "410",
    "412",
    "413",
    "500",
  ],
  "POST /v1/organizations/{organizationId}/execution-plans/{id}/resolve": [
    "200",
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "410",
    "412",
    "413",
    "422",
    "429",
    "500",
    "503",
  ],
  "POST /v1/organizations/{organizationId}/invitations": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "429",
    "500",
  ],
  "POST /v1/organizations/{organizationId}/jobs/{id}/cancel": [
    "200",
    "401",
    "403",
    "404",
    "409",
    "500",
  ],
  "POST /v1/organizations/{organizationId}/leave": ["200", "401", "403", "404", "409", "500"],
  "POST /v1/organizations/{organizationId}/sources": [
    "200",
    "201",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "500",
  ],
  "POST /v1/organizations/{organizationId}/transfer-ownership": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "413",
    "500",
  ],
  "PUT /v1/auth/default-organization": ["200", "400", "401", "404", "409", "413", "500"],
  "PUT /v1/organizations/{organizationId}/sources/{id}/upload": [
    "200",
    "400",
    "401",
    "403",
    "404",
    "409",
    "410",
    "413",
    "500",
  ],
};
