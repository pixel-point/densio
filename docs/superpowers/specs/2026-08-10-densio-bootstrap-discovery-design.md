# Densio bootstrap discovery design

## Goal

Make this command install the stable Densio bootstrap, not the live runtime bundle:

```sh
npx skills add pixel-point/densio --skill densio
```

The installed bootstrap must continue resolving the current runtime instructions once per invocation through `npx --yes densio@latest --json skill`.

## Current problem

`skills/densio/SKILL.md` and `skills/densio-bootstrap/SKILL.md` both declare `name: densio`. Repository-wide discovery deduplicates that identifier and selects `skills/densio/SKILL.md`, so `--skill densio` installs the static runtime bundle. The folder name `densio-bootstrap` is not a selectable skill identifier because its frontmatter still declares `name: densio`.

## Selected design

Keep exactly one discoverable Densio skill:

- `skills/densio/SKILL.md` becomes the stable bootstrap.
- `skills/densio/agents/openai.yaml` remains the public skill metadata.
- The canonical runtime sources move to `skill-bundle/entrypoint.md` and `skill-bundle/references/*.md`.
- No file under `skill-bundle` is named `SKILL.md`, preventing generic recursive skill discovery from treating the live bundle as an installable skill.
- The API continues publishing the runtime entrypoint as `SKILL.md`; the source filename is an internal repository detail.

The API raw imports, Docker build context, CLI drift test, and bundle tests will point at `skill-bundle`. The bootstrap test will compare the public bootstrap metadata with the internal runtime entrypoint metadata and assert the live-resolution safeguards.

## Alternatives considered

### Mark the runtime skill internal

Adding `metadata.internal: true` is smaller, but it leaks installer-specific metadata into the live runtime bundle and depends on every installer honoring the same extension. It also leaves two skills with the same identifier.

### Rename the runtime skill

Changing the canonical runtime frontmatter to `name: densio-runtime` removes the collision, but exposes an internal implementation detail as another installable public skill and weakens the runtime bundle's identity.

### Require the direct GitHub tree URL

The current direct-path command works, but it does not satisfy the intended repository-level `--skill densio` installation experience.

## Data flow

1. The Skills CLI discovers the sole public `skills/densio/SKILL.md` entry.
2. It installs that file under the agent's `densio` skill directory.
3. When activated, the bootstrap runs `npx --yes densio@latest --json skill` once.
4. The CLI retrieves the API's validated bundle and returns an entrypoint named `SKILL.md` plus its relative references.
5. The agent uses the returned content for that invocation without persisting it.

## Validation

- Add or update tests proving `skills/densio/SKILL.md` is the bootstrap and only one public Densio `SKILL.md` exists under `skills`.
- Preserve byte-for-byte API bundle tests against `skill-bundle`.
- Preserve bootstrap/runtime activation metadata equality and live-resolution safety assertions.
- Run `pnpm lint`, `pnpm format`, `pnpm test`, and `pnpm typecheck` because build-time raw imports and Docker paths change.
- In a fresh temporary directory, run the real repository-level install command and verify `skills-lock.json` records `skills/densio/SKILL.md` while the installed body contains the live-resolution command.
