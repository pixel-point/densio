import { describe, expect, it } from "vitest";

import {
  assertCheckoutUrl,
  assertMagicLinkUrl,
  assertPaidPlan,
  assertStripeTestKey,
  requiredEnvironment,
} from "./journey.ts";

describe("requiredEnvironment", () => {
  it("returns a configured value", () => {
    expect(
      requiredEnvironment(
        { DENSIO_SYNTHETIC_API_URL: "https://api.densio.sh" },
        "DENSIO_SYNTHETIC_API_URL",
      ),
    ).toBe("https://api.densio.sh");
  });

  it("rejects missing and blank values without printing another secret", () => {
    expect(() => requiredEnvironment({}, "DENSIO_SYNTHETIC_EMAIL")).toThrow(
      "DENSIO_SYNTHETIC_EMAIL is required",
    );
    expect(() => requiredEnvironment({ SECRET: "  " }, "SECRET")).toThrow("SECRET is required");
  });
});

describe("assertCheckoutUrl", () => {
  it("accepts hosted Stripe Checkout", () => {
    expect(assertCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_example#fragment")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_example#fragment",
    );
  });

  it("rejects non-HTTPS and lookalike hosts", () => {
    expect(() => assertCheckoutUrl("http://checkout.stripe.com/c/pay/example")).toThrow(
      "hosted Stripe Checkout",
    );
    expect(() =>
      assertCheckoutUrl("https://checkout.stripe.com.example.test/c/pay/example"),
    ).toThrow("hosted Stripe Checkout");
  });
});

describe("assertMagicLinkUrl", () => {
  it("accepts only confirmation links for the deployment under test", () => {
    const link = "https://api.densio.sh/v1/auth/confirm?token=secret";
    expect(assertMagicLinkUrl(link, "https://api.densio.sh")).toBe(link);
    expect(() => assertMagicLinkUrl(link, "https://staging-api.densio.sh")).toThrow(
      "deployment under test",
    );
  });
});

describe("assertStripeTestKey", () => {
  it("prevents the staging synthetic from using a live Stripe key", () => {
    expect(assertStripeTestKey("sk_test_example")).toBe("sk_test_example");
    expect(() => assertStripeTestKey("sk_live_example")).toThrow("Stripe test-mode secret key");
  });
});

describe("assertPaidPlan", () => {
  it("accepts only plans that can run the AV1 production synthetic", () => {
    expect(assertPaidPlan("basic")).toBe("basic");
    expect(assertPaidPlan("pro")).toBe("pro");
    expect(assertPaidPlan("scale")).toBe("scale");
    expect(() => assertPaidPlan("free")).toThrow("basic, pro, or scale");
  });
});
