import {
  ArtifactAuthorizationSchema,
  ArtifactDescriptorSchema,
  ArtifactDeletedResponseSchema,
  ArtifactMaterializationReceiptSchema,
  AuthStatusSchema,
  BillingSessionResponseSchema,
  BillingStatusSchema,
  OrganizationMembershipSchema,
  OrganizationInvitationSchema,
  OrganizationInvitationAcceptResponseSchema,
  ExecutionPlanCreateResponseSchema,
  JobEventSchema,
  JobStatusSchema,
  PreparedSourceDeletionReceiptSchema,
  PreparedSourceStatusSchema,
  PreparedSourceListResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { Schema } from "effect";

const JobAcceptedSchema = Schema.Struct({
  jobId: Schema.NonEmptyString,
  resumeCommand: Schema.NonEmptyString,
  statusUrl: Schema.NonEmptyString,
});

const CliCredentialsSchema = Schema.Struct({ accessToken: Schema.NonEmptyString });

export const decodeAuthStatus = Schema.decodeUnknownSync(successEnvelope(AuthStatusSchema));
export const decodeBillingStatus = Schema.decodeUnknownSync(successEnvelope(BillingStatusSchema));
export const decodeOrganization = Schema.decodeUnknownSync(
  successEnvelope(OrganizationMembershipSchema),
);
export const decodeInvitation = Schema.decodeUnknownSync(
  successEnvelope(OrganizationInvitationSchema),
);
export const decodeInvitationAcceptance = Schema.decodeUnknownSync(
  successEnvelope(OrganizationInvitationAcceptResponseSchema),
);
export const decodeArtifactAuthorization = Schema.decodeUnknownSync(
  successEnvelope(ArtifactAuthorizationSchema),
);
export const decodeArtifactDescriptor = Schema.decodeUnknownSync(
  successEnvelope(ArtifactDescriptorSchema),
);
export const decodePreparedSourceList = Schema.decodeUnknownSync(
  successEnvelope(PreparedSourceListResponseSchema),
);
export const decodeArtifactDeletion = Schema.decodeUnknownSync(
  successEnvelope(ArtifactDeletedResponseSchema),
);
export const decodeArtifactMaterialization = Schema.decodeUnknownSync(
  successEnvelope(ArtifactMaterializationReceiptSchema),
);
export const decodeBillingSession = Schema.decodeUnknownSync(
  successEnvelope(BillingSessionResponseSchema),
);
export const decodeExecutionPlanCreated = Schema.decodeUnknownSync(
  successEnvelope(ExecutionPlanCreateResponseSchema),
);
export const decodeJobAccepted = Schema.decodeUnknownSync(successEnvelope(JobAcceptedSchema));
export const decodeJobEvent = Schema.decodeUnknownSync(JobEventSchema);
export const decodeJobStatus = Schema.decodeUnknownSync(successEnvelope(JobStatusSchema));
export const decodePreparedSource = Schema.decodeUnknownSync(
  successEnvelope(PreparedSourceStatusSchema),
);
export const decodePreparedSourceDeletion = Schema.decodeUnknownSync(
  successEnvelope(PreparedSourceDeletionReceiptSchema),
);
export const decodeCliCredentials = Schema.decodeUnknownSync(CliCredentialsSchema);
