<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# PrimeUI Exported Project

## Instruction Model

- Read this file and the nearest nested `AGENTS.md` before editing an area. Nested files add local rules without weakening this root contract.
- Keep `AGENTS.md` files focused on policy, ownership, and acceptance criteria. Detailed multi-step workflows belong in project-local skills.
- If a documented path, command, or architectural rule changes, update the matching instruction source in the same change.

## Project Baseline

- Stack: Next.js App Router, React, strict TypeScript, Tailwind CSS v4, and source-owned shadcn components. New account components use Base UI; existing marketing primitives retain their current APIs.
- `src/app` owns routes, layouts, metadata, and framework adapters.
- `src/components/ui` owns reusable primitives; `src/components/pages/<slug>` owns page sections; `src/components/content` owns rich-content renderers.
- `src/content` owns Markdown content. `src/configs`, `src/constants`, `src/contexts`, `src/hooks`, `src/lib`, `src/styles`, and `src/types` own their corresponding shared concerns.
- Import source files through `@/` aliases. Use relative imports within one tightly coupled local folder when that is clearer.

## Core Workflow

- Use `pnpm` for installs and scripts.
- Inspect `git status`, the current implementation, and nearby patterns before editing. Preserve unrelated work.
- Reuse or extend existing components and helpers before creating parallel implementations.
- Prefer root-cause fixes over suppressing symptoms. Keep changes minimal and task-scoped.
- Do not commit, push, publish, deploy, change global configuration, or add unrelated dependencies unless the user explicitly asks.

## Next.js And React

- Read the relevant bundled Next.js document before changing a framework API, special file, routing convention, rendering mode, cache behavior, metadata, image, or font behavior.
- Server Components are the default. Add `'use client'` only at the smallest boundary that needs browser APIs, effects, local interaction state, or event handlers.
- Keep Client Component props serializable and do not make Client Components `async`.
- Use the configured Next.js runtime tools when the development server is running; let reported compilation and runtime errors guide fixes.

## Appearance

- The website supports only the light theme. Keep one color palette and do not add theme-switching UI or system-theme detection.
- Use Geist Pixel Square for headings, mixed with Geist Sans and Handjet (weight 500, with the opening “A” at 700) in the home hero, and Geist Sans for body and interface text. Account, authentication, invitation, and billing return pages use Geist Sans for headings as well. Their Prime Studio measurements and white palette are scoped to `.account-theme`. Configure fonts centrally in `src/lib/theme-fonts.ts` and `src/styles/globals.css`.

## TypeScript, UI, And Assets

- Keep TypeScript strict. Narrow unknown data instead of bypassing contracts with `any`, ignored errors, or unsafe casts.
- Preserve semantic HTML, keyboard access, visible focus, reduced motion, labels, error associations, and meaningful alternative text.
- Prefer existing semantic tokens and statically discoverable Tailwind classes. Use `cn` for class composition and `cva` for reusable variants where those patterns already exist.
- Use `next/image` for content images when optimization is appropriate. Keep static public assets under `public/` and do not edit generated `.next/` output.

## Skill Routing

- Project-local skills live under `.agents/skills/` or `.claude/skills/`, depending on the selected agent.
- Use `tailwind-design-system` for shared token, theme, utility, or component-system work.
- Use `git-commit` only when the user asks to create a commit.

## PrimeUI Integration

- PrimeUI project linkage lives in `.primeui/project.json`.
- Refresh project-local agent configuration with `npx @primeuicom/cli ai-setup --ai-preset <agent>`; never modify user-global agent configuration from this repository.
- Interactive PrimeUI CLI setup can configure multiple AI presets; command flags accept one preset at a time.
- Optional Prime implementation workflows are installed separately from the Prime Skills marketplace.
- Use the configured `primeui`, `next-devtools`, and `chrome-devtools` MCP servers for project data, framework diagnostics, and rendered behavior. Do not infer runtime success from configuration alone.

## Validation And Handoff

- Run the checks relevant to the touched scope. The full application gate is `pnpm format`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
- Verify routes, interactions, and visual changes against a running app in representative desktop and mobile states.
- Review the final diff and status. Report commands actually run, failures, and any unverified runtime, browser, deployment, or publication boundary.
