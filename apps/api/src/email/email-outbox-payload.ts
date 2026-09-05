import { Schema } from "effect";

export const EmailOutboxPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("storage-retention"),
    organizationId: Schema.String,
    revision: Schema.Number,
    deadline: Schema.Number,
    phase: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("magic-login"),
    challengeId: Schema.NonEmptyString,
    encryptedConfirmationUrl: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("organization-invitation"),
    invitationId: Schema.NonEmptyString,
  }),
]);
export type EmailOutboxPayload = typeof EmailOutboxPayloadSchema.Type;
export const decodeEmailOutboxPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(EmailOutboxPayloadSchema),
);
