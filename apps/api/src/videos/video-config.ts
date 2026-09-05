import type { BillingPriceIds } from "../billing/billing-repository.ts";
export interface VideoServiceConfig {
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
  readonly managedTargetId?: string;
  readonly managedPublicOrigin?: string;
}
