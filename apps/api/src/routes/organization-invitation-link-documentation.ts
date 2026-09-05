import { OrganizationInvitationLinkRequestSchema } from "@densio/shared";
import { describeRoute } from "hono-openapi";
import { jsonRequest, queryParameters } from "./openapi-support.ts";

const htmlResponse = (description: string) => ({
  description,
  content: { "text/html": { schema: { type: "string" as const } } },
});
const responses = {
  "200": htmlResponse("The invitation confirmation or completed acceptance page."),
  "400": htmlResponse("The invitation token or submitted form is invalid."),
  "404": htmlResponse("The invitation link is invalid or unknown."),
  "409": htmlResponse("The invitation or organization is unavailable, or membership conflicts."),
  "410": htmlResponse("The invitation has expired."),
  "500": htmlResponse("An internal error prevented loading or accepting the invitation."),
};

export const invitationLinkDocumentation = (accept: boolean) =>
  describeRoute({
    operationId: accept ? "acceptOrganizationInvitationLink" : "viewOrganizationInvitationLink",
    summary: accept
      ? "Accept an emailed organization invitation in the browser"
      : "View an emailed organization invitation",
    description:
      "The signed email link authorizes only the addressed membership. GET is read-only; POST explicitly accepts. No general session is issued. Expiry, revocation, current grant authority and removed memberships are enforced. Acceptance preserves organization defaults.",
    tags: ["Organizations"],
    security: [],
    ...(accept
      ? {
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: jsonRequest(OrganizationInvitationLinkRequestSchema).content[
                  "application/json"
                ].schema,
              },
            },
          },
        }
      : {
          parameters: queryParameters(OrganizationInvitationLinkRequestSchema, {
            token: "Signed, recipient-bound invitation credential from the email.",
          }),
        }),
    responses: {
      ...responses,
      ...(accept ? { "413": htmlResponse("The submitted form exceeds 4096 bytes.") } : {}),
    },
  });
