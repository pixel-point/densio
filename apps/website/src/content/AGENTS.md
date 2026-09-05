# Content Instructions

These instructions apply to everything under `src/content/`. Read the root `AGENTS.md` first.

## Source Of Truth

- Edit content in its source file instead of copying it into route or component markup.
- Preserve existing folder ownership, slugs, frontmatter fields, taxonomy references, and lookup identifiers.
- Use the Markdown and MDX vocabulary already supported by the central rendering pipeline. Wire new rich-content components into the shared mapping instead of assuming ad hoc support.

## Quality And Validation

- Keep titles, descriptions, links, and heading structure specific, consistent, and accessible.
- Check every listing, metadata, feed, or navigation consumer affected by a content-model change.
- Verify final rendering for media, tables, tabs, custom components, and discoverability-sensitive changes.
