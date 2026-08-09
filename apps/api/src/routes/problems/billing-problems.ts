import {
  BillingCustomerNotFound,
  BillingUserNotFound,
  BillingWebhookUnmatched,
  InvalidStripeWebhook,
  StripeGatewayError,
} from "../../billing/billing-errors.ts";
import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";

export const billingCustomerProblemDescriptor = defineProblem({
  code: "BILLING_CUSTOMER_REQUIRED",
  description: "The user has no Stripe customer to manage.",
  status: 409,
  title: "Billing account unavailable",
});

export const billingUserProblemDescriptor = defineProblem({
  code: "BILLING_USER_NOT_FOUND",
  description: "The authenticated billing account no longer exists.",
  status: 404,
  title: "Billing user not found",
});

export const invalidStripeWebhookProblemDescriptor = defineProblem({
  code: "INVALID_STRIPE_WEBHOOK",
  description: "The Stripe webhook signature or payload is invalid.",
  status: 400,
  title: "Invalid Stripe webhook",
});

export const unmatchedWebhookProblemDescriptor = defineProblem({
  code: "STRIPE_WEBHOOK_UNMATCHED",
  description: "The Stripe event cannot yet be linked to a local user.",
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
  if (error instanceof BillingUserNotFound) return billingUserProblem();
  if (error instanceof InvalidStripeWebhook) return invalidStripeWebhookProblem();
  if (error instanceof BillingWebhookUnmatched) return unmatchedWebhookProblem();
  if (error instanceof StripeGatewayError) return stripeUnavailableProblem();
  return undefined;
};

const billingCustomerProblem = () =>
  makeDescriptorProblem(billingCustomerProblemDescriptor, {
    detail: "No Stripe customer is linked to this account yet.",
    retryable: false,
    suggestedAction: "Start a Pro Checkout session first.",
  });

const billingUserProblem = () =>
  makeDescriptorProblem(billingUserProblemDescriptor, {
    detail: "The authenticated billing account no longer exists.",
    retryable: false,
    suggestedAction: "Sign in again or contact the server operator.",
  });

const invalidStripeWebhookProblem = () =>
  makeDescriptorProblem(invalidStripeWebhookProblemDescriptor, {
    detail: "The Stripe webhook signature or payload is invalid.",
    retryable: false,
    suggestedAction: "Verify the Stripe webhook secret and raw-body forwarding.",
  });

const unmatchedWebhookProblem = () =>
  makeDescriptorProblem(unmatchedWebhookProblemDescriptor, {
    detail: "The Stripe event could not yet be linked to a local user.",
    retryable: true,
    suggestedAction: "Allow Stripe to retry the webhook after customer mapping.",
  });

const stripeUnavailableProblem = () =>
  makeDescriptorProblem(stripeUnavailableProblemDescriptor, {
    detail: "Stripe could not complete the requested billing operation.",
    retryable: true,
    suggestedAction: "Retry the billing command shortly.",
  });
