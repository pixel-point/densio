import {
  BillingCustomerNotFound,
  BillingUserNotFound,
  BillingWebhookUnmatched,
  InvalidStripeWebhook,
  StripeGatewayError,
} from "../../billing/billing-errors.ts";
import { makeProblem } from "../../errors/problem-details.ts";

export const billingProblem = (error: unknown) => {
  if (error instanceof BillingCustomerNotFound) return billingCustomerProblem();
  if (error instanceof BillingUserNotFound) return billingUserProblem();
  if (error instanceof InvalidStripeWebhook) return invalidStripeWebhookProblem();
  if (error instanceof BillingWebhookUnmatched) return unmatchedWebhookProblem();
  if (error instanceof StripeGatewayError) return stripeUnavailableProblem();
  return undefined;
};

const billingCustomerProblem = () =>
  makeProblem({
    code: "BILLING_CUSTOMER_REQUIRED",
    detail: "No Stripe customer is linked to this account yet.",
    retryable: false,
    status: 409,
    suggestedAction: "Start a Pro Checkout session first.",
    title: "Billing account unavailable",
  });

const billingUserProblem = () =>
  makeProblem({
    code: "BILLING_USER_NOT_FOUND",
    detail: "The authenticated billing account no longer exists.",
    retryable: false,
    status: 404,
    suggestedAction: "Sign in again or contact the server operator.",
    title: "Billing user not found",
  });

const invalidStripeWebhookProblem = () =>
  makeProblem({
    code: "INVALID_STRIPE_WEBHOOK",
    detail: "The Stripe webhook signature or payload is invalid.",
    retryable: false,
    status: 400,
    suggestedAction: "Verify the Stripe webhook secret and raw-body forwarding.",
    title: "Invalid Stripe webhook",
  });

const unmatchedWebhookProblem = () =>
  makeProblem({
    code: "STRIPE_WEBHOOK_UNMATCHED",
    detail: "The Stripe event could not yet be linked to a local user.",
    retryable: true,
    status: 503,
    suggestedAction: "Allow Stripe to retry the webhook after customer mapping.",
    title: "Stripe event not ready",
  });

const stripeUnavailableProblem = () =>
  makeProblem({
    code: "STRIPE_UNAVAILABLE",
    detail: "Stripe could not create the requested billing session.",
    retryable: true,
    status: 502,
    suggestedAction: "Retry the billing command shortly.",
    title: "Stripe unavailable",
  });
