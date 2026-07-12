import { expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { validateProductionConfig } from "../src/runtime-config.ts";

const validEnvironment = {
  AUTH_IP_HASH_SECRET: "a".repeat(64),
  AUTH_OUTBOX_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  EMAIL_FROM: "FFmpeg API <login@media.acme.test>",
  PUBLIC_BASE_URL: "https://media.acme.test",
  RESEND_API_KEY: "re_live_realistic",
  STRIPE_PRO_PRICE_ID: "price_pro_realistic",
  STRIPE_SECRET_KEY: "sk_live_realistic",
  STRIPE_WEBHOOK_SECRET: "whsec_realistic",
};

it("accepts explicit external integration configuration", () => {
  expect(() => validateProductionConfig(loadConfig(validEnvironment))).not.toThrow();
});

it("rejects shipped placeholders before serving traffic", () => {
  expect(() =>
    validateProductionConfig(
      loadConfig({
        ...validEnvironment,
        RESEND_API_KEY: "re_replace-me",
        STRIPE_SECRET_KEY: "sk_live_replace-me",
      }),
    ),
  ).toThrow(/RESEND_API_KEY.*STRIPE_SECRET_KEY/);
});

it("requires HTTPS for a non-local public origin", () => {
  expect(() =>
    validateProductionConfig(
      loadConfig({ ...validEnvironment, PUBLIC_BASE_URL: "http://media.acme.test" }),
    ),
  ).toThrow(/PUBLIC_BASE_URL/);
});

it("requires a non-placeholder 32-byte outbox encryption key", () => {
  expect(() =>
    validateProductionConfig(
      loadConfig({ ...validEnvironment, AUTH_OUTBOX_ENCRYPTION_KEY: "0".repeat(64) }),
    ),
  ).toThrow(/AUTH_OUTBOX_ENCRYPTION_KEY/);
  expect(() =>
    validateProductionConfig(
      loadConfig({ ...validEnvironment, AUTH_OUTBOX_ENCRYPTION_KEY: "not-hex" }),
    ),
  ).toThrow(/AUTH_OUTBOX_ENCRYPTION_KEY/);
});
