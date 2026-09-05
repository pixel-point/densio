# App Router Instructions

These instructions apply to everything under `src/app/`. Read the root `AGENTS.md` first.

## Ownership

- Keep `src/app` focused on URL structure, layouts, metadata, route handlers, and Next.js special files.
- Keep route files thin. Compose page sections from `src/components/pages/<slug>` and shared UI from `src/components`.
- Keep reusable visual markup, content parsing, and general utilities out of route files.

## Next.js Rules

- Read the relevant bundled document under `node_modules/next/dist/docs/` before changing a special file or framework API.
- Use Server Components by default. Add a client boundary only when the route owns unavoidable browser interaction.
- Keep layouts structural. Providers, header, footer, and other shell concerns belong there; reusable page sections do not.
- Keep metadata, canonical paths, static params, not-found behavior, and route-group conventions aligned with nearby routes.

## Validation

- Compile the touched route and inspect framework diagnostics while the dev server is running.
- Verify navigation, metadata, and rendered behavior directly when they change.
