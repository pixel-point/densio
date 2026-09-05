# Components Instructions

These instructions apply to everything under `src/components/`. Read the root `AGENTS.md` first.

## Placement

- Keep generic reusable primitives in `src/components/ui`.
- Keep page-family sections in `src/components/pages/<slug>` and rich-content renderers in `src/components/content`.
- Keep header, footer, and other site-wide UI in their existing shared component folders.
- Inspect existing primitives, content renderers, and nearby page sections before adding a component.

## Component Rules

- Reuse existing components before introducing parallel markup. Keep shared APIs composable and prop-driven.
- Read `components.json` before changing shadcn-managed primitives. Preserve the installed primitive's public API unless all consumers are updated together.
- Use `cn` for class composition and `cva` for stable reusable variants. Prefer semantic tokens and statically discoverable Tailwind classes.
- Add `'use client'` only at the smallest interactive boundary. Preserve semantic HTML, keyboard behavior, focus states, labels, and reduced-motion behavior.

## Validation

- Check shared component changes across every affected route, not only the page that motivated the edit.
- Verify interactive and visual changes in representative desktop and mobile states.
