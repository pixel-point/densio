import { expect, it } from "vitest";
import {
  renderSignInConfirmationEmail,
  renderOrganizationInvitationEmail,
  renderStorageRetentionEmail,
} from "../src/index.ts";

it.each([
  {
    name: "sign-in confirmation",
    render: () =>
      renderSignInConfirmationEmail({ verificationUrl: "https://api.example.test/confirm" }),
  },
  {
    name: "organization invitation",
    render: () =>
      renderOrganizationInvitationEmail({
        name: "Example Studio",
        acceptanceUrl: "https://api.example.test/invitation",
      }),
  },
  {
    name: "storage retention",
    render: () =>
      renderStorageRetentionEmail({
        organizationName: "Example Studio",
        deadline: 1_800_000_000_000,
      }),
  },
])("gives $name a full-width white background without body styles", async ({ render }) => {
  const { html } = await render();
  const bodyContent = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? "";
  const outerTable = bodyContent.match(/<table\b[^>]*>/i)?.[0] ?? "";
  const outerCell = bodyContent.match(/<td\b[^>]*>/i)?.[0] ?? "";

  expect(outerTable).toContain('width="100%"');
  expect(outerTable).not.toContain("max-width");
  expect(outerTable).toMatch(/background-color:\s*#ffffff/i);
  expect(outerTable).toMatch(/bgcolor="#ffffff"/i);
  expect(outerCell).toMatch(/background-color:\s*#ffffff/i);
});

it("renders sign-in HTML and plain text with the exact action URL and company footer", async () => {
  const verificationUrl = "https://api.example.test/v1/auth/confirm?token=example&next=cli";
  const email = await renderSignInConfirmationEmail({ verificationUrl });
  expect(email.subject).toBe("Confirm your sign-in to Densio");
  expect(email.html).toContain("<h1");
  expect(email.html).toContain("Access your account");
  expect(email.html).toContain(
    'href="https://api.example.test/v1/auth/confirm?token=example&amp;next=cli"',
  );
  expect(email.text).toContain(verificationUrl);
  expect(email.text.split("\n")).toContain(verificationUrl);
  expect(email.text).toContain("If the button above does not work");
  expect(email.text).toContain("Prime UI, Inc.");
  expect(email.text).toContain("131 Continental Dr, Suite 305, Newark, DE 19713, USA");
  expect(email.text).not.toContain("<table");
  expect(email.html).not.toMatch(/Collage|Unsubscribe|123 Market Street|localhost/);
});

it("escapes untrusted URLs in HTML while preserving them in plain text", async () => {
  const verificationUrl =
    'https://api.example.test/verify?next="><script>alert(1)</script>&value="';
  const email = await renderSignInConfirmationEmail({ verificationUrl });
  expect(email.html).not.toContain("<script>");
  expect(email.html).toContain("&lt;script&gt;");
  expect(email.html).toContain("&quot;");
  expect(email.text).toContain(verificationUrl);
});

it("renders an invitation link and organization name without HTML injection", async () => {
  const name = 'Studio <script>alert("x")</script> & friends';
  const email = await renderOrganizationInvitationEmail({
    name,
    acceptanceUrl: "https://api.example.test/v1/organization-invitations/confirm?token=example",
  });
  expect(email.subject).toBe("Invitation to a Densio organization");
  expect(email.text).toContain(name);
  expect(email.text).toContain("Accept invitation");
  expect(email.text).toContain(
    "https://api.example.test/v1/organization-invitations/confirm?token=example",
  );
  expect(email.text).not.toContain("npx");
  expect(email.html).toContain("&lt;script&gt;");
  expect(email.html).not.toContain("<script>");
});

it("explains storage actions and deletion consequences with a readable date and no commands", async () => {
  const email = await renderStorageRetentionEmail({
    organizationName: "Example Studio",
    deadline: 1_800_000_000_000,
  });
  expect(email.subject).toBe("Action required: your Densio storage is over its limit");
  expect(email.text).toContain("Example Studio");
  expect(email.text).toContain("January 15, 2027");
  expect(email.text).not.toContain("2027-01-15T08:00:00.000Z");
  expect(email.text).toContain("upgrade your plan or delete videos you no longer need");
  expect(email.text).toContain("delete the copies hosted by Densio to free up space");
  expect(email.text).toContain("Densio will permanently delete videos it hosts");
  expect(email.text).toContain("starting with the most recently stored");
  expect(email.text).toContain("On the Free plan, this means deleting all videos hosted by Densio");
  expect(email.text).toContain("Links and embeds for deleted videos will stop working");
  expect(email.text).toContain("Videos stored in your own storage are not affected");
  expect(email.text).not.toMatch(/densio --org|VIDEO_ID|CONNECTION_ID|EXPORT_KEY/);
  expect(email.html).toContain("<h1");
});
