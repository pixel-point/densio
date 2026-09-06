import {
  OrganizationInvitationLinkRequestSchema,
  OrganizationInvitationLinkResponseSchema,
} from "@densio/shared";
import { describeRoute } from "hono-openapi";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import {
  jsonRequest,
  problemResponses,
  queryParameters,
  successResponse,
} from "./openapi-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";

const errors = problemResponses(
  invalidRequestProblemDescriptor,
  internalErrorProblemDescriptor,
  ...(
    [
      "ORGANIZATION_INVITATION_NOT_FOUND",
      "ORGANIZATION_INVITATION_EXPIRED",
      "ORGANIZATION_INVITATION_UNAVAILABLE",
      "ORGANIZATION_NOT_ACTIVE",
      "ORGANIZATION_INVITATION_CONFLICT",
    ] as const
  ).map(organizationProblemDescriptor),
);
export const invitationLinkDocumentation = (accept: boolean, legacy = false) =>
  describeRoute({
    operationId: legacy
      ? accept
        ? "acceptLegacyOrganizationInvitationLink"
        : "redirectOrganizationInvitationLink"
      : accept
        ? "acceptOrganizationInvitationLink"
        : "viewOrganizationInvitationLink",
    summary: legacy
      ? "Continue an invitation on the website"
      : accept
        ? "Accept an emailed invitation"
        : "Inspect an emailed invitation",
    description:
      "The signed token authorizes the addressed membership only. Inspection is read-only; acceptance preserves organization defaults and does not issue a session.",
    tags: ["Organizations"],
    security: [],
    ...(accept
      ? {
          requestBody: legacy
            ? {
                required: true,
                content: {
                  "application/x-www-form-urlencoded": {
                    schema: jsonRequest(OrganizationInvitationLinkRequestSchema).content[
                      "application/json"
                    ].schema,
                  },
                },
              }
            : jsonRequest(OrganizationInvitationLinkRequestSchema),
        }
      : {
          parameters: queryParameters(OrganizationInvitationLinkRequestSchema, {
            token: "Recipient-bound email invitation token.",
          }),
        }),
    responses: {
      ...(legacy
        ? { "303": { description: "Continue on the website invitation screen." } }
        : {
            "200": successResponse(
              "Verified invitation details and acceptance state.",
              OrganizationInvitationLinkResponseSchema,
            ),
          }),
      ...(!legacy || accept ? errors : {}),
      ...(accept ? problemResponses(requestTooLargeProblemDescriptor) : {}),
    },
  });
