# API Agent Instructions

## Effect v4

- Use `../../repos/effect` as read-only reference material when writing Effect code in this package.
- Read `../../repos/effect/LLMS.md` before changing Effect-based application code.
- Prefer examples and patterns from the vendored Effect source over guesses or web search.
- Do not edit files under `../../repos/` unless explicitly asked.
- Do not import from `../../repos/`; application code should import from package dependencies.

## API Boundaries

- Hono owns HTTP transport and routing.
- Effect owns business logic, services, schemas, errors, and workflows.

## Effect Style

- Use `Effect.gen(function* () { ... })` for composition.
- Use `Effect.fn("Domain.method")` for named Effect-returning functions.
- Do not return `Effect` from helpers unless they actually perform effectful work.
- In `Effect.gen` / `Effect.fn`, bind services to named variables before calling methods.
- Avoid nested service yields such as `yield* (yield* Foo.Service).bar()`.
- Use `Effect.void` instead of `Effect.succeed(undefined)`.
- Prefer Effect Schema helpers for parsing untrusted input over manual `JSON.parse` wrappers.
