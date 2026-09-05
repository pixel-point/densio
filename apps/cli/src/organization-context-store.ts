import { readFile } from "node:fs/promises";
import { HttpUrlSchema, IdentifierSchema } from "@densio/shared";
import { Predicate, Schema } from "effect";
import { credentialApiOrigin, writePrivateJson } from "./config.ts";

const OrganizationContextSchema = Schema.Struct({
  apiOrigin: HttpUrlSchema,
  userId: IdentifierSchema,
  organizationId: IdentifierSchema,
});
const decodeContext = Schema.decodeUnknownSync(Schema.fromJsonString(OrganizationContextSchema), {
  onExcessProperty: "error",
});

export const organizationContextPath = (credentialsPath: string) =>
  `${credentialsPath}.organization.json`;

export const writeOrganizationContext = (
  credentialsPath: string,
  context: typeof OrganizationContextSchema.Type,
) =>
  writePrivateJson(organizationContextPath(credentialsPath), {
    ...context,
    apiOrigin: credentialApiOrigin(context.apiOrigin),
  });

export const readOrganizationContext = async (
  credentialsPath: string,
  apiUrl: string,
  userId: string,
) => {
  const content = await readFile(organizationContextPath(credentialsPath), "utf8").catch(
    (cause: unknown) => {
      if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") return undefined;
      throw cause;
    },
  );
  if (content === undefined) return undefined;
  const context = decodeContext(content);
  return context.apiOrigin === credentialApiOrigin(apiUrl) && context.userId === userId
    ? context.organizationId
    : undefined;
};
