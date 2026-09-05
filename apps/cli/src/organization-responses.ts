import {
  ArtifactAuthorizationSchema,
  ArtifactDeletedResponseSchema,
  ArtifactDescriptorSchema,
  BillingContactResponseSchema,
  BillingSessionResponseSchema,
  BillingStatusSchema,
  CapabilitiesSchema,
  ExecutionPlanCreateResponseSchema,
  ExecutionPlanExecuteResponseSchema,
  ExecutionPlanResolveResponseSchema,
  ExecutionPlanStatusSchema,
  JobEventPageSchema,
  JobListResponseSchema,
  JobStatusSchema,
  OrganizationAuditPageSchema,
  OrganizationDeletionReceiptSchema,
  OrganizationInvitationSchema,
  OrganizationInvitationsResponseSchema,
  OrganizationMembershipSchema,
  OrganizationMemberRemovalSchema,
  OrganizationMemberSchema,
  OrganizationMembersResponseSchema,
  OrganizationSchema,
  PreparedSourceCreateResponseSchema,
  PreparedSourceDeletionReceiptSchema,
  PreparedSourceListResponseSchema,
  PreparedSourceStatusSchema,
  type JobStatus,
} from "@densio/shared";
import { organizationResponse } from "./organization-client.ts";

const root = <Value extends { readonly organizationId: string }>(value: Value) => [value];
const jobOwners = (job: JobStatus) => [
  job,
  ...("video" in job && job.video ? [job.video] : []),
  ...("artifacts" in job ? job.artifacts : []),
  ...("receipt" in job ? [job.receipt, ...job.receipt.artifacts] : []),
];

// Each nested resource is named explicitly against the public contract. Opaque
// options, diagnostics, and problem details are not ownership-bearing resources.
export const organizationResponses = {
  ArtifactAuthorization: organizationResponse(ArtifactAuthorizationSchema, (value) => [
    value,
    value.artifact,
  ]),
  ArtifactDeletedResponse: organizationResponse(ArtifactDeletedResponseSchema, root),
  ArtifactDescriptor: organizationResponse(ArtifactDescriptorSchema, root),
  BillingContactResponse: organizationResponse(BillingContactResponseSchema, root),
  BillingSessionResponse: organizationResponse(BillingSessionResponseSchema, root),
  BillingStatus: organizationResponse(BillingStatusSchema, root),
  Capabilities: organizationResponse(CapabilitiesSchema, root),
  ExecutionPlanCreateResponse: organizationResponse(ExecutionPlanCreateResponseSchema, (value) => [
    value,
    value.plan,
  ]),
  ExecutionPlanExecuteResponse: organizationResponse(ExecutionPlanExecuteResponseSchema, root),
  ExecutionPlanResolveResponse: organizationResponse(
    ExecutionPlanResolveResponseSchema,
    (value) => [value, value.plan],
  ),
  ExecutionPlanStatus: organizationResponse(ExecutionPlanStatusSchema, root),
  JobEventPage: organizationResponse(JobEventPageSchema, root),
  JobListResponse: organizationResponse(JobListResponseSchema, (value) => [value, ...value.jobs]),
  JobStatus: organizationResponse(JobStatusSchema, jobOwners),
  JobLookupResponse: organizationResponse(JobStatusSchema, jobOwners),
  OrganizationAuditPage: organizationResponse(OrganizationAuditPageSchema, (value) => [
    value,
    ...value.events,
  ]),
  OrganizationDeletionReceipt: organizationResponse(OrganizationDeletionReceiptSchema, root),
  OrganizationInvitation: organizationResponse(OrganizationInvitationSchema, root),
  OrganizationInvitationsResponse: organizationResponse(
    OrganizationInvitationsResponseSchema,
    (value) => [value, ...value.invitations],
  ),
  OrganizationMembership: organizationResponse(OrganizationMembershipSchema, (value) => [
    value.organization,
    value.membership,
  ]),
  OrganizationMemberRemoval: organizationResponse(OrganizationMemberRemovalSchema, root),
  OrganizationMember: organizationResponse(OrganizationMemberSchema, root),
  OrganizationMembersResponse: organizationResponse(OrganizationMembersResponseSchema, (value) => [
    value,
    ...value.members,
  ]),
  Organization: organizationResponse(OrganizationSchema, root),
  PreparedSourceCreateResponse: organizationResponse(
    PreparedSourceCreateResponseSchema,
    (value) => [value, value.source],
  ),
  PreparedSourceDeletionReceipt: organizationResponse(PreparedSourceDeletionReceiptSchema, root),
  PreparedSourceListResponse: organizationResponse(PreparedSourceListResponseSchema, (value) => [
    value,
    ...value.sources,
  ]),
  PreparedSourceStatus: organizationResponse(PreparedSourceStatusSchema, root),
};
