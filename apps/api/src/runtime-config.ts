import type { AppConfig } from "./config.ts";

export const validateProductionConfig = (config: AppConfig) => {
  const publicUrl = URL.canParse(config.publicBaseUrl) ? new URL(config.publicBaseUrl) : undefined;
  const localPublicUrl =
    publicUrl?.hostname === "localhost" ||
    publicUrl?.hostname === "127.0.0.1" ||
    publicUrl?.hostname === "[::1]";
  const required = [
    [
      "AUTH_IP_HASH_SECRET",
      config.authIpHashSecret.length >= 32 && !isPlaceholder(config.authIpHashSecret),
    ],
    ["AUTH_OUTBOX_ENCRYPTION_KEY", validEncryptionKey(config.authOutboxEncryptionKey)],
    ["EMAIL_FROM", config.emailFrom.includes("@") && !isPlaceholder(config.emailFrom)],
    [
      "PUBLIC_BASE_URL",
      publicUrl !== undefined && (publicUrl.protocol === "https:" || localPublicUrl),
    ],
    ["RESEND_API_KEY", validPrefixedSecret(config.resendApiKey, "re_")],
    ["STRIPE_BASIC_PRICE_ID", validPrefixedSecret(config.stripeBasicPriceId, "price_")],
    ["STRIPE_PREMIUM_PRICE_ID", validPrefixedSecret(config.stripePremiumPriceId, "price_")],
    ["STRIPE_PRO_PRICE_ID", validPrefixedSecret(config.stripeProPriceId, "price_")],
    ["STRIPE_SECRET_KEY", validPrefixedSecret(config.stripeSecretKey, "sk_")],
    ["STRIPE_WEBHOOK_SECRET", validPrefixedSecret(config.stripeWebhookSecret, "whsec_")],
  ] as const;
  const missing = required.flatMap(([name, valid]) => (valid ? [] : [name]));
  if (missing.length > 0) {
    throw new Error(`Missing or placeholder configuration: ${missing.join(", ")}`);
  }
  const priceIds = Object.values(config.billing.priceIds);
  if (new Set(priceIds).size !== priceIds.length) {
    throw new Error("Stripe price IDs must be unique across paid plans.");
  }
};

const validPrefixedSecret = (value: string, prefix: string) =>
  value.startsWith(prefix) && value.length > prefix.length && !isPlaceholder(value);

const validEncryptionKey = (value: string) =>
  /^[\dA-Fa-f]{64}$/u.test(value) && !/^(.)\1{63}$/u.test(value) && !isPlaceholder(value);

const isPlaceholder = (value: string) => /replace|development-only|example\.com/iu.test(value);
