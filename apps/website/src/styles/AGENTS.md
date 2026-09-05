# Styles Instructions

These instructions apply to everything under `src/styles/`. Read the root `AGENTS.md` first.

## Source Of Truth

- Keep `src/styles/globals.css` as the central source for Tailwind v4 theme wiring, semantic tokens, and shared utilities.
- Use global styles for reusable system behavior, not to hide page-specific fixes.
- Prefer existing Tailwind utilities and semantic tokens before custom CSS or arbitrary values.
- Promote repeated values into one clearly named token, utility, or variant. Do not create multiple names for the same concept.

## Change Safety

- Treat `@theme`, `@utility`, global typography, syntax highlighting, and media-style changes as broad-impact changes.
- Check representative pages and component families after changing shared styles or tokens.
- Verify responsive behavior, focus presentation, contrast, and reduced motion where affected.
