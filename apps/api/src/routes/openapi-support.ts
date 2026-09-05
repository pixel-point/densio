import { ProblemDetailsSchema, successEnvelope } from "@densio/shared";
import { Schema } from "effect";
import type { OpenAPIV3_1 } from "openapi-types";

import type { ProblemDescriptor } from "../errors/problem-details.ts";

export const jsonRequest = <S extends Schema.Top>(
  schema: S,
  examples?: Readonly<Record<string, { readonly summary: string; readonly value: S["Type"] }>>,
) => ({
  content: {
    "application/json": {
      schema: openApiSchema(schema),
      ...(examples === undefined ? {} : { examples }),
    },
  },
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

export const queryParameters = <Fields extends Schema.Struct.Fields>(
  schema: Schema.Struct<Fields>,
  descriptions: Readonly<Record<keyof Fields & string, string>>,
): OpenAPIV3_1.ParameterObject[] => {
  const object = openApiSchema(schema);
  // openapi-types still aliases 3.1 parameters to 3.0 types; the emitted schemas are 3.1.
  return Object.entries(object.properties ?? {}).map(
    ([name, property]) =>
      ({
        description: descriptions[name as keyof typeof descriptions],
        in: "query",
        name,
        required: object.required?.includes(name) ?? false,
        schema: property,
      }) as OpenAPIV3_1.ParameterObject,
  );
};

export const headerParameter = (
  name: string,
  description: string,
  required = false,
  schema: Schema.Top = Schema.String,
): OpenAPIV3_1.ParameterObject =>
  ({
    ...parameter(name, "header", description, required),
    schema: openApiSchema(schema),
  }) as OpenAPIV3_1.ParameterObject;

export const binaryBody = {
  content: {
    "application/octet-stream": { schema: { format: "binary", type: "string" as const } },
  },
  required: true,
};

export const binaryResponse = (description: string) => ({
  content: {
    "*/*": { schema: { format: "binary", type: "string" as const } },
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
