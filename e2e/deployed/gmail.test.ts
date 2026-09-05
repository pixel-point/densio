import { describe, expect, it } from "vitest";

import { gmailSearchQuery, taggedGmailAddress, verificationUrlFromMessage } from "./gmail.ts";

const encode = (value: string) => Buffer.from(value).toString("base64url").replace(/=+$/u, "");

describe("taggedGmailAddress", () => {
  it("creates a unique address without changing the mailbox", () => {
    expect(taggedGmailAddress("synthetics@gmail.com", "staging-1723456789")).toBe(
      "synthetics+staging-1723456789@gmail.com",
    );
  });

  it("replaces an existing tag so repeated runs do not accumulate tags", () => {
    expect(taggedGmailAddress("synthetics+old@gmail.com", "staging-new")).toBe(
      "synthetics+staging-new@gmail.com",
    );
  });
});

describe("gmailSearchQuery", () => {
  it("restricts results to recent messages for the recipient and subject", () => {
    expect(gmailSearchQuery("synthetics+run@gmail.com")).toBe(
      'to:synthetics+run@gmail.com subject:"Confirm your sign-in to Densio" newer_than:1d',
    );
  });
});

describe("verificationUrlFromMessage", () => {
  it("extracts the confirmation URL from nested plain-text MIME parts", () => {
    const message = {
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          {
            body: { data: encode("This is the HTML fallback.") },
            mimeType: "text/html",
          },
          {
            body: {
              data: encode(
                "Confirm your login:\nhttps://staging-api.densio.sh/v1/auth/confirm?token=secret-token\n",
              ),
            },
            mimeType: "text/plain",
          },
        ],
      },
    };

    expect(verificationUrlFromMessage(message)).toBe(
      "https://staging-api.densio.sh/v1/auth/confirm?token=secret-token",
    );
  });

  it("decodes an HTML-escaped query string", () => {
    const message = {
      payload: {
        body: {
          data: encode(
            '<a href="https://api.densio.sh/v1/auth/confirm?token=secret&amp;source=email">Confirm</a>',
          ),
        },
        mimeType: "text/html",
      },
    };

    expect(verificationUrlFromMessage(message)).toBe(
      "https://api.densio.sh/v1/auth/confirm?token=secret&source=email",
    );
  });

  it("returns undefined when the email has no Densio confirmation URL", () => {
    expect(
      verificationUrlFromMessage({
        payload: { body: { data: encode("No link in this message.") }, mimeType: "text/plain" },
      }),
    ).toBeUndefined();
  });
});
