import { Effect } from "effect";
import type { StripeGatewayDefinition } from "../src/billing/stripe-gateway.ts";

const unexpected = () => Effect.die("Unexpected Stripe operation in an isolated test.");
export const unusedStripeGateway: StripeGatewayDefinition = {
  retrieveCustomer: unexpected,
  createCustomer: unexpected,
  findCustomer: unexpected,
  updateCustomer: unexpected,
  createCheckoutSession: unexpected,
  retrieveCheckoutSession: unexpected,
  findCheckoutSession: unexpected,
  createPortalSession: unexpected,
  retrieveSubscription: unexpected,
  listCustomerSubscriptions: unexpected,
  parseWebhook: unexpected,
};
