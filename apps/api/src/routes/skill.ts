import { SkillBundleSchema, type SkillBundle, successEnvelope } from "@densio/shared";
import { Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import { successResponse } from "./openapi-support.ts";
import { beginRequest, successEnvelopeInput } from "./route-support.ts";

const decodeSkillEnvelope = Schema.decodeUnknownSync(successEnvelope(SkillBundleSchema));
const skillDocumentation = describeRoute({
  description: "Returns the current repository-authored Densio skill and its Markdown references.",
  operationId: "getSkill",
  responses: {
    "200": successResponse("The current Densio skill bundle.", SkillBundleSchema),
  },
  summary: "Get the current Densio skill",
  tags: ["Skill"],
});

export interface SkillRouteDependencies {
  readonly bundle: SkillBundle;
  readonly createCorrelationId: () => string;
}

export const createSkillRoutes = (dependencies: SkillRouteDependencies) => {
  const routes = new Hono();
  routes.get("/v1/skill", skillDocumentation, (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    context.header("cache-control", "no-store");
    return context.json(
      decodeSkillEnvelope(successEnvelopeInput(dependencies.bundle, correlationId)),
    );
  });
  return routes;
};
