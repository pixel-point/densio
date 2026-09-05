# Densio emails

Private React Email templates for every transactional email sent by Densio:

- Densio sign-in confirmation
- Organization invitations
- Storage retention notices

## Preview and edit

From the repository root, run:

```sh
pnpm --filter @densio/emails dev
```

Open [the local preview](http://localhost:3001). Each template includes inert
`PreviewProps`; previewing requires no API, database, provider credentials, or
email delivery. The confirmation preview points to `example.com`.

Edit `src/emails/` for individual messages, `src/components/email-layout.tsx` for
the shared layout, and `src/theme.ts` for colors and typography. Shared components
live in `src/components/`. Subjects and HTML/plain-text rendering
live in `src/render.tsx`.

The starting design adapts React Email's
[Matte activation template](https://demo.react.email/preview/02-Matte/activation):
generous spacing and a large heading. Densio uses `#2C2B31` text, white backgrounds,
black action buttons with white text, and a main container without borders or shadows.
A text wordmark replaces the demo illustration so delivered emails need no
remotely hosted assets. The footer contains Densio's transactional branding.
See [the third-party notice](./THIRD_PARTY_NOTICES.md) for attribution.

## API integration

The API imports render functions from `@densio/emails`. Each takes typed template
props and resolves to `{ subject, html, text }`. React Email renders the HTML and
derives the plain-text alternative from the same content.

The API owns eligibility checks, recipients, tokens, storage policy, the outbox,
retries, and Resend. Templates have no database or provider dependencies. Storage notices
explain recovery options and deletion consequences without CLI commands, with deadlines
displayed as calendar dates in UTC. Organization invitations use
an API-generated signed acceptance link and a browser confirmation page. The email package
only renders this URL; the API verifies the recipient and grants membership.

Invitation signatures derive a separate signing key from `AUTH_OUTBOX_ENCRYPTION_KEY`.
Rotating that key invalidates outstanding invitation links; revoke and reissue affected
invitations. The outbox stores invitation IDs, while link credentials are generated when
the email is rendered.

The package exports compiled JavaScript and declarations. Root Turbo commands
build dependencies automatically. When running the API directly after changing a
template, first rebuild the email package:

```sh
pnpm --filter @densio/emails build
pnpm --filter @densio/emails test
```

The API Docker build includes and builds this package. The preview UI is only a
development dependency and is not included in the API runtime image.
