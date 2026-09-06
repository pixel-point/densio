# Project Guide

This document explains how to run, build, and maintain the project locally.

## Technology Stack

- [Next.js](https://nextjs.org/) - application framework and routing
- [Tailwind CSS](https://tailwindcss.com/) - utility-first styling
- [shadcn/ui](https://ui.shadcn.com/) - source-owned components; account controls use Base UI

## Requirements

- Node.js 22.18+
- Corepack-managed pnpm 11.7.0

## Getting Started

This PrimeUI starter is the `@densio/website` workspace. Install dependencies and start it from the monorepo root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @densio/website dev
```

The remaining commands in this guide run from `apps/website`. The monorepo root `pnpm dev` command starts the API.

The app will be available at `http://localhost:3001`.

If environment variables are required for a specific setup:

```bash
cp .env.example .env
```

## Development Workflow

1. Start the dev server with `pnpm dev`.
2. Add or update routes in `src/app`.
3. Build reusable UI in `src/components/ui`.
4. Build page-specific sections in `src/components/pages/<slug>`
5. Compose pages from those sections inside route files under `src/app`.
6. Run quality checks before committing:
   - `pnpm lint`
   - `pnpm format`
   - `pnpm typecheck` (`next typegen && tsgo --noEmit`)
   - `pnpm build`

## Available Scripts

- `pnpm dev` - start Next.js in development mode
- `pnpm build` - create a production build
- `pnpm start` - run the production server
- `pnpm lint` - run OXC lint checks
- `pnpm lint:fix` - run OXC lint with auto-fixes
- `pnpm format` - check formatting with Oxfmt
- `pnpm format:fix` - format files with Oxfmt
- `pnpm typecheck` - generate Next.js route types and run TypeScript type checks with tsgo

## Project Structure

```text
.
├─ public/                    # static assets served as-is
├─ src/
│  ├─ app/                    # Next.js App Router (routes, layouts, not-found)
│  ├─ components/
│  │  ├─ ui/                  # shared UI primitives
│  │  └─ pages/
│  │     ├─ home/             # components used only by the Home page
│  │     └─ <slug>/           # components used only by one specific page
│  ├─ content/                # markdown content grouped by feature/page
│  ├─ configs/                # app and website configuration
│  ├─ constants/              # static constants
│  ├─ contexts/               # React providers/contexts
│  ├─ hooks/                  # reusable React hooks
│  ├─ lib/                    # utilities and framework helpers
│  ├─ styles/                 # global and feature styles
│  └─ types/                  # shared TypeScript types
├─ next.config.ts             # Next.js configuration
├─ postcss.config.mjs         # PostCSS configuration
├─ tailwind.plugins.mjs       # Tailwind plugin setup
├─ .oxlintrc.json             # OXC lint configuration
├─ .oxfmtrc.json              # OXC formatter configuration
└─ package.json
```

## Website Config

Website-level settings are defined in `src/configs/website-config.ts`.

Use this config for branding, metadata defaults, and repository links. Common fields:

- `projectName` - project name used in UI and metadata
- `metaThemeColor` - the light browser theme color
- `src/app/opengraph-image.tsx` - generated OG/social preview image used for Open Graph and Twitter
- `githubOrg` / `githubRepo` - repository metadata for links/integrations

Example:

```ts
const config = {
  projectName: "<YOUR_PROJECT_NAME>",
  metaThemeColor: "#ffffff",
};
```

## Typography and Appearance

The website uses a single light theme. Colors live in `src/styles/globals.css`; the header,
footer, and social images share the logo and browser theme color in `src/configs/website-config.ts`.

Fonts are configured in `src/lib/theme-fonts.ts` and self-hosted through the `geist` package and `next/font`:

- Geist Pixel Square for headings (`font-heading` and semantic `h1`–`h6` elements).
- Geist Sans for paragraphs and interface text (`font-sans`).
- Handjet (`font-display`, weight 500, with the opening “A” at 700) mixed with regular and medium Geist Sans and Geist Pixel Square in the home hero.

## Content Directory

The blog is temporarily disabled. Its routes are preserved in `src/app/(website)/_blog`, a Next.js private folder, and its content and components remain in place. To restore it, rename `_blog` to `blog` and add the blog link back to `src/constants/menus.ts`.

Content lives in `src/content` and is organized by folders per section/page type.

Example structure:

```text
src/content/
├─ blog/
├─ docs/
└─ legal/
```

Rules for this project:

- Use Markdown only (`.md` files).
- Keep content grouped by folder (for example: `docs/`, `blog/`, `legal/`).
- Use nested folders when you need hierarchy inside a section.

### Documentation (`/docs`) Conventions

For the `/docs` section, this project follows the same page conventions as FumaDocs. Use the official [FumaDocs page conventions](https://www.fumadocs.dev/docs/page-conventions) as the primary reference when creating or editing docs pages.

## Build and Output

- Run `pnpm build` to generate the production build in `.next/`.
- Run `pnpm start` to serve the compiled build.
- `postbuild` can generate sitemap files and `robots.txt` via `next-sitemap`.
- Generated/runtime directories such as `.next/`, `.turbo/`, and `node_modules/` are not source files.

## Account website and API

The website has no database, ORM, or direct persistence layer. Server Components and Server Actions call the API with the server-only `DENSIO_API_URL`. The API owns authentication, memberships, permissions, invitations, billing, credits, and all database writes. API response envelopes are decoded with `@densio/shared` schemas.

Set `WEBSITE_BASE_URL` on the API to the public website origin and `DENSIO_API_URL` on the website to the API origin. For local development these default to ports 3001 and 3000 respectively. Set both explicitly for deployment. Existing Stripe return URL overrides must also point to the website. Configure trusted reverse proxies on the API as usual; do not use browser-provided authentication headers.

Browser login uses opaque API-issued credentials in host-only, HTTP-only, SameSite=Lax cookies, secure in production. API session lifetime and revocation remain authoritative. Next.js Server Actions enforce same-origin mutations. Opening the emailed link automatically confirms the request through a browser-initiated Server Action. The initiating browser receives its session and redirects to the dashboard without another click; its original waiting tab follows automatically. GET-only link previews do not consume the challenge. CLI challenges are confirmed without being redeemed as browser sessions.

| Route                                                 | Purpose                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `/auth/login`                                         | Email sign-in and waiting state                                    |
| `/auth/confirm?token=…`                               | Automatic login completion and dashboard redirect                  |
| `/invites/[invitationId]?token=…`                     | Inspect and accept an email invitation                             |
| `/app`                                                | Resolve the last available browser organization or account default |
| `/app/[organizationId]/settings`                      | Organization name and details                                      |
| `/app/[organizationId]/settings/profile`              | Email, account default organization, sign out                      |
| `/app/[organizationId]/settings/members`              | Members, pending invitations, invite and revoke                    |
| `/app/[organizationId]/settings/billing`              | Plan, credits, billing contact, checkout and portal                |
| `/checkout/success`, `/checkout/canceled`, `/billing` | Public returns from hosted billing flows                           |

The organization in the URL controls every read and mutation. The top switcher preserves the settings section; it does not change the CLI default. Only the explicit Profile form changes the account default. The API enforces all permissions even if a form is forged or membership changes while a page is open.

Settings navigation follows Prime's preload-and-render approach: links prefetch the full destination, the current page stays visible during navigation, and member and invitation data load together before rendering. There is no generic settings loading screen.

Account pages use Geist Sans and scoped `.account-theme` tokens: 48px navbar, 816px maximum container with 24px desktop padding, 768px cards, 36/45px page headings with -0.03em tracking, 14/20px tabs with -0.025em tracking, 14px card corners, and 44px inputs with 8px corners. Marketing typography stays in its existing scope. `components.json` targets the Base UI account primitives under `src/components/ui/account`.

### Disposable browser verification

From the repository root, bundle and run the local API fixture. Its SQLite database and media live in a temporary directory, email goes to a separate loopback test inbox, and all Stripe calls use a controlled substitute. Stop the fixture with Ctrl+C to remove temporary data.

```bash
corepack pnpm exec esbuild e2e/support/website-preview.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=apps/api/dist/website-preview.js --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
node apps/api/dist/website-preview.js
```

In another terminal, from `apps/website`:

```bash
DENSIO_API_URL=http://127.0.0.1:3800 DENSIO_SITE_BUILD_DIR=.next/website-preview corepack pnpm exec next dev --port 3801 --hostname 127.0.0.1
```

Open `http://127.0.0.1:3801/auth/login` and the test inbox at `http://127.0.0.1:3802`. Use disposable `@densio.test` emails. The fixture checkout goes directly to the return screen without contacting Stripe or charging anything. The optional build-directory setting keeps this verification server separate from a running development server.
