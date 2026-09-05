# Project Guide

This document explains how to run, build, and maintain the project locally.

## Technology Stack

- [Next.js](https://nextjs.org/) - application framework and routing
- [Tailwind CSS](https://tailwindcss.com/) - utility-first styling
- [shadcn/ui](https://ui.shadcn.com/) - reusable UI component patterns built on Radix primitives

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

The app will be available at `http://localhost:3000`.

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
