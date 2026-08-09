import { describe, expect, it } from "vitest";

import { renderMagicLinkEmail } from "../src/auth/magic-link-email.ts";

describe("renderMagicLinkEmail", () => {
  it("renders a useful text and HTML email", () => {
    const verificationUrl = "https://video.example/auth/verify?token=abc";
    const email = renderMagicLinkEmail({
      expiresInMinutes: 15,
      verificationUrl,
    });

    expect(email.subject).toBe("Confirm your Densio CLI login");
    expect(email.text).toContain(verificationUrl);
    expect(email.text).toContain("15 minutes");
    expect(email.html).toContain(`href="${verificationUrl}"`);
    expect(email.html).toContain("15 minutes");
  });

  it("escapes every HTML-sensitive character in the verification URL", () => {
    const injected = `https://video.example/verify?next="><script>alert('x')</script>&x='`;
    const email = renderMagicLinkEmail({
      expiresInMinutes: 10,
      verificationUrl: injected,
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain(injected);
    expect(email.html).toContain(
      "https://video.example/verify?next=&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;x=&#39;",
    );
  });
});
