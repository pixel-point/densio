# Agent Instructions

## Monorepo Boundaries

- `apps/api` owns the HTTP API surface.
- `apps/cli` owns CLI entrypoints and command behavior.

## Package Instructions

- Before changing files under `apps/api`, read `apps/api/AGENTS.md`.

## Completion Checks

- After completing any task, run `pnpm lint`, `pnpm format`, and `pnpm test` before handing off.
- If the task changes TypeScript types, package boundaries, or build configuration, also run `pnpm typecheck`.

## Lint Rules

- Do not weaken or disable lint rules to bypass failures unless the change is clearly justified by the task.
- Do not bypass the 100-line function limit or 1000-line file limit. Split code into clearer modules or functions instead.

## Style Guide

### General Principles

- Keep code in one function unless extraction is clearly composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible.
- Avoid `any`.
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity.
- Prefer functional array methods like `map`, `filter`, and `flatMap` over loops when they make the data flow clearer.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Imports

- Never alias imports.
- Never use star imports.

### Variables

- Prefer `const` over `let`.
- Use ternaries or early returns instead of reassignment.
- Reduce total variable count by inlining when a value is only used once.

### Control Flow

- Avoid `else` statements.
- Prefer early returns.

### Complex Logic

- When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.
- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept.

### Testing

- Avoid mocks as much as possible.
- Test actual implementation.
- Do not duplicate implementation logic into tests.
