import { randomUUID } from "node:crypto";

import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { openAPIRouteHandler } from "hono-openapi";

const scalarCdn = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.63.0";
const scalarCdnOrigin = "https://cdn.jsdelivr.net";

export const registerDocumentationRoutes = (app: Hono) => {
  app.get(
    "/openapi.json",
    openAPIRouteHandler(app, {
      documentation: {
        components: {
          securitySchemes: {
            bearerAuth: { scheme: "bearer", type: "http" },
          },
        },
        info: {
          description: "Media compression, extraction, and quality comparison API.",
          title: "Densio API",
          version: "1.0.0",
        },
      },
      exclude: [/^\/billing(?:\/|$)/, "/docs", "/openapi.json"],
    }),
  );
  app.get(
    "/docs",
    Scalar((context) => {
      const nonce = randomUUID();
      context.header("content-security-policy", documentationPolicy(nonce));
      return {
        agent: { disabled: true },
        cdn: scalarCdn,
        documentDownloadType: "json",
        hideTestRequestButton: true,
        nonce,
        pageTitle: "Densio API Reference",
        showDeveloperTools: "never",
        telemetry: false,
        url: "/openapi.json",
        withDefaultFonts: false,
      };
    }),
  );
};

const documentationPolicy = (nonce: string) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${scalarCdnOrigin}`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
