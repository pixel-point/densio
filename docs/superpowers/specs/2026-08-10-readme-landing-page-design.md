# README landing page design

## Goal

Rewrite the main README as a product landing page for developers and agent users. Lead with the practical outcome: smaller video removes weight from websites and improves page performance. Explain the product without inflated claims, then keep enough operational detail for people evaluating self-hosting.

## Selected structure

1. Open with the site-performance problem and Densio's agent-first value proposition.
2. Put the Skills CLI installation command and one realistic `$densio` prompt immediately after the introduction.
3. List only capabilities implemented today: VP9, H.265, AV1, audio handling, image extraction, CRF comparison, transforms, durable jobs, and verified artifacts.
4. Explain why Densio exists on top of FFmpeg: it owns compression policy, inspection, durable execution, and output handling so agents do not assemble arbitrary command lines or manage long local processes.
5. State the speed tradeoff plainly. Densio favors compression efficiency over turnaround time, including VP9's `best` deadline and H.265's `veryslow` preset. Avoid claiming every codec uses its absolute slowest available setting.
6. Present the current plan limits, including 30 monthly Free credits and support for all codecs. Point higher-volume work and repeated experiments toward paid plans or self-hosting.
7. End with concise self-hosting, direct CLI, development, and license sections. Remove the current deep operator runbook from the landing-page flow.

## Alternatives considered

### Keep the existing technical README and add a marketing introduction

This preserves every operational detail but leaves the main page dominated by deployment, authentication, and billing internals. Readers still have to cross a long technical document before understanding why they would use Densio.

### Make the README product-only

A short marketing page would be easy to scan but would underserve an AGPL project that explicitly offers self-hosting. It would also make the self-hosting claim feel unsupported.

### Landing page with a compact operator tail

This is the selected approach. It puts product value and agent use first, keeps current facts visible, and preserves the commands needed to evaluate or run the project without turning the page back into an operations manual.

## Voice

Use short, direct sentences and concrete nouns. Say that Densio is deliberately slow and explain why. Do not call it instant, effortless, revolutionary, or production-ready. Avoid fake contrast, decorative emphasis, slogans that overpromise, and unsupported performance numbers.

## Validation

- Check every codec, preset, plan, credit, upload, retention, and workflow statement against source files.
- Keep the requested install command exactly as `npx skills add pixel-point/densio --skill densio`.
- Verify the prompt names `$densio` and asks for work supported by the current skill.
- Run the no-ai-slop evaluation and revise any failing line.
- Run `pnpm lint`, `pnpm format`, and `pnpm test` before handoff.
