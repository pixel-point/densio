import { Schema } from "effect";

export class StripeGatewayError extends Schema.TaggedErrorClass<StripeGatewayError>()(
  "StripeGatewayError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}

export class InvalidStripeWebhook extends Schema.TaggedErrorClass<InvalidStripeWebhook>()(
  "InvalidStripeWebhook",
  { cause: Schema.Defect() },
) {}

export class BillingStorageError extends Schema.TaggedErrorClass<BillingStorageError>()(
  "BillingStorageError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}

export class BillingUserNotFound extends Schema.TaggedErrorClass<BillingUserNotFound>()(
  "BillingUserNotFound",
  { userId: Schema.String },
) {}

export class BillingCustomerNotFound extends Schema.TaggedErrorClass<BillingCustomerNotFound>()(
  "BillingCustomerNotFound",
  { userId: Schema.String },
) {}

export class BillingWebhookUnmatched extends Schema.TaggedErrorClass<BillingWebhookUnmatched>()(
  "BillingWebhookUnmatched",
  { eventId: Schema.String },
) {}
