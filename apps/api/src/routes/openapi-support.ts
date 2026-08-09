import { ProblemDetailsSchema, successEnvelope } from "@densio/shared";
import { Schema } from "effect";
import type { OpenAPIV3_1 } from "openapi-types";

import type { ProblemDescriptor } from "../errors/problem-details.ts";

export const jsonRequest = <S extends Schema.Top>(schema: S) => ({
  content: { "application/json": { schema: openApiSchema(schema) } },
  required: true,
});

export const successResponse = <S extends Schema.Top>(description: string, schema: S) => ({
  content: {
    "application/json": { schema: openApiSchema(successEnvelope(schema)) },
  },
  description,
});

export const jsonResponse = <S extends Schema.Top>(description: string, schema: S) => ({
  content: { "application/json": { schema: openApiSchema(schema) } },
  description,
});

export const problemResponse = (description: string) => ({
  content: { "application/problem+json": { schema: openApiSchema(ProblemDetailsSchema) } },
  description,
});

export const problemResponses = (...descriptors: ReadonlyArray<ProblemDescriptor>) =>
  Object.fromEntries(
    [...new Set(descriptors.map(({ status }) => status))].map((status) => [
      String(status),
      problemResponse(
        [
          ...new Set(
            descriptors
              .filter((descriptor) => descriptor.status === status)
              .map(({ description }) => description),
          ),
        ].join(" "),
      ),
    ]),
  );

export const bearerSecurity = [{ bearerAuth: [] }];
export const optionalBearerSecurity = [{}, { bearerAuth: [] }];

export const pathParameter = (name: string, description: string) =>
  parameter(name, "path", description, true);

export const queryParameter = (name: string, description: string, required = false) =>
  parameter(name, "query", description, required);

export const headerParameter = (name: string, description: string, required = false) =>
  parameter(name, "header", description, required);

export const binaryBody = {
  content: {
    "application/octet-stream": { schema: { format: "binary", type: "string" as const } },
  },
  required: true,
};

export const binaryResponse = (description: string) => ({
  content: {
    "application/octet-stream": { schema: { format: "binary", type: "string" as const } },
  },
  description,
});

export const emptyResponse = (description: string) => ({ description });

const openApiSchema = <S extends Schema.Top>(schema: S) =>
  Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as OpenAPIV3_1.SchemaObject;

const parameter = (
  name: string,
  location: OpenAPIV3_1.ParameterObject["in"],
  description: string,
  required: boolean,
): OpenAPIV3_1.ParameterObject => ({
  description,
  in: location,
  name,
  required,
  schema: { type: "string" },
});
