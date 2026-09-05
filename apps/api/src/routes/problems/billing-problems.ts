import {
  BillingCustomerNotFound,
  BillingWebhookUnmatched,
  InvalidStripeWebhook,
  StripeGatewayError,
} from "../../billing/billing-errors.ts";
import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";

export const billingCustomerProblemDescriptor = defineProblem({
  code: "BILLING_CUSTOMER_REQUIRED",
  description: "The organization has no Stripe customer to manage.",
  status: 409,
  title: "Billing account unavailable",
});

export const invalidStripeWebhookProblemDescriptor = defineProblem({
  code: "INVALID_STRIPE_WEBHOOK",
  description: "The Stripe webhook signature or payload is invalid.",
  status: 400,
  title: "Invalid Stripe webhook",
});

export const unmatchedWebhookProblemDescriptor = defineProblem({
  code: "STRIPE_WEBHOOK_UNMATCHED",
  description:
    "The Stripe event cannot be reconciled with the persisted organization billing account.",
  status: 503,
  title: "Stripe event not ready",
});

export const stripeUnavailableProblemDescriptor = defineProblem({
  code: "STRIPE_UNAVAILABLE",
  description: "Stripe could not complete the requested operation.",
  status: 502,
  title: "Stripe unavailable",
});

export const billingProblem = (error: unknown) => {
  if (error instanceof BillingCustomerNotFound) return billingCustomerProblem();
  if (error instanceof InvalidStripeWebhook) return invalidStripeWebhookProblem();
  if (error instanceof BillingWebhookUnmatched) return unmatchedWebhookProblem();
  if (error instanceof StripeGatewayError) return stripeUnavailableProblem();
  return undefined;
};

const billingCustomerProblem = () =>
  makeDescriptorProblem(billingCustomerProblemDescriptor, {
    detail: "No Stripe customer is linked to this account yet.",
    retryable: false,
    suggestedAction: "An organization owner can start a paid-plan checkout when authorized.",
  });

const invalidStripeWebhookProblem = () =>
  makeDescriptorProblem(invalidStripeWebhookProblemDescriptor, {
    detail: "The Stripe webhook signature or payload is invalid.",
    retryable: false,
    suggestedAction: "Verify the Stripe webhook secret and raw-body forwarding.",
  });

const unmatchedWebhookProblem = () =>
  makeDescriptorProblem(unmatchedWebhookProblemDescriptor, {
    detail: "The Stripe event could not be reconciled with an organization billing account.",
    retryable: true,
    suggestedAction: "Allow Stripe to retry the webhook after customer mapping.",
  });

const stripeUnavailableProblem = () =>
  makeDescriptorProblem(stripeUnavailableProblemDescriptor, {
    detail: "Stripe could not complete the requested billing operation.",
    retryable: true,
    suggestedAction: "Retry the billing command shortly.",
  });
