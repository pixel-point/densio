import { html } from "hono/html";

export const invitationConfirmationPage = (input: {
  name: string;
  email: string;
  role: string;
  token: string;
}) =>
  invitationPage(
    "Accept invitation",
    html`
      <p>
        You have been invited to join <strong>${input.name}</strong> as
        ${input.role === "admin" ? "an admin" : "a member"}.
      </p>
      <p>This invitation is for <strong>${input.email}</strong>.</p>
      <form method="post" action="/v1/organization-invitations/confirm">
        <input type="hidden" name="token" value="${input.token}" />
        <button type="submit">Accept invitation</button>
      </form>
      <p class="note">Joining does not change your default organization.</p>
    `,
  );

export const invitationAcceptedPage = (name: string) =>
  invitationPage(
    "Invitation accepted",
    html`
      <p>You have joined <strong>${name}</strong> on Densio.</p>
      <p>You can close this page and continue in Densio.</p>
    `,
  );

export const invitationFailurePage = (title: string, message: string) =>
  invitationPage(title, html`<p>${message}</p>`);

const invitationPage = (title: string, content: ReturnType<typeof html>) => html`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${title} · Densio</title>
      <style>
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          background: #fff;
          color: #2c2b31;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        main {
          max-width: 600px;
          margin: 0 auto;
          padding: 64px 24px;
          overflow-wrap: anywhere;
        }
        .brand {
          margin: 0 0 48px;
          font-size: 32px;
          font-weight: 700;
          letter-spacing: -1.6px;
        }
        h1 {
          margin: 0 0 12px;
          font-size: 30px;
          font-weight: 600;
        }
        p {
          margin: 0 0 24px;
          font-size: 16px;
          line-height: 24px;
          letter-spacing: -0.025em;
        }
        button {
          background: #fff;
          color: inherit;
          border: 1px solid #2c2b31;
          border-radius: 6px;
          padding: 10px 40px;
          font-family: inherit;
          font-size: 16px;
          font-weight: 500;
          line-height: 1;
          cursor: pointer;
        }
        button:focus-visible {
          outline: 2px solid #2c2b31;
          outline-offset: 4px;
        }
        .note {
          margin-top: 32px;
          font-size: 14px;
        }
      </style>
    </head>
    <body>
      <main>
        <p class="brand">densio</p>
        <h1>${title}</h1>
        ${content}
      </main>
    </body>
  </html>`;
