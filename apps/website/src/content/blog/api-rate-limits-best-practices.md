---
title: "API Rate Limits: Best Practices"
caption: "How to design rate limits that protect your platform while keeping integrations predictable."
isFeatured: false
publishedAt: "2025-04-10T10:00:00.000Z"
updatedAt: "2025-04-11T10:00:00.000Z"
category: "news"
authors:
  - id: "john-doe"
  - id: "markus-smith"
cover: "/images/cover-4.jpg"
seo:
  title: "API Rate Limits: Best Practices"
  description: "Design rate limits that protect your platform while keeping integrations predictable."
---

API rate limits protect SaaS infrastructure from spikes, but they also shape developer experience. The goal is not to block clients, it is to keep the platform stable while making the rules predictable enough that integrations can succeed.

When rate limits are unclear, clients retry blindly, create duplicate load, and turn a small spike into an outage. Good limits are boring: consistent responses, clear headers, and a documented retry pattern.

## Communicate limits clearly

Document limits per endpoint and include headers that describe remaining quota and reset time. Put the rules in your documentation and reference them from every integration guide, not only from a single “API overview” page.

You should also decide what you are limiting:

- Per token or per workspace for fair usage.
- Per IP for abuse prevention.
- Per endpoint for expensive operations.

In most SaaS APIs, per token is the best default because it maps to how integrations are built and rotated.

:::info Prefer predictable behavior

A consistent 429 response with clear headers is better than random timeouts. Timeouts waste retries and create duplicate load.

:::

## Make retries safe by design

Rate limiting only works if clients can recover. That means you need a clear error response, a safe retry window, and idempotency for write operations.

For writes, define idempotency keys for endpoints like “create invoice” or “send email.” This prevents duplicates when the client retries after a 429 or a network error. Even if you do not support full idempotency, ensure “create” endpoints can detect duplicates based on external IDs.

<Details title="What to include in a 429 response">

Return a clear error code, a short message, and headers that tell the client how long to wait. If you can, include a pointer to the relevant section in your documentation so integrations can implement the correct behavior once and reuse it.

</Details>

## Show a safe retry pattern

```typescript tab="TypeScript"
async function fetchWithBackoff(request: () => Promise<Response>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await request();
    if (res.status !== 429) return res;
    const waitMs = Math.min(2000, 250 * (attempt + 1));
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error("Rate limit exceeded");
}
```

```python tab="Python"
import time

def fetch_with_backoff(request):
  for attempt in range(5):
    res = request()
    if res.status_code != 429:
      return res
    wait_ms = min(2000, 250 * (attempt + 1))
    time.sleep(wait_ms / 1000)
  raise Exception("Rate limit exceeded")
```

## Design for fairness and bursts

Many workloads are bursty: deploys, imports, and scheduled syncs can cause short spikes that are still legitimate. If you only support strict per-minute limits, clients may fail even though average usage is reasonable.

A practical approach is to allow small bursts while enforcing a steady rate over time. Pair this with clear limits per token so one noisy integration does not degrade the experience for the rest of the workspace.

## Conclusion

Rate limits are successful when they are boring. Keep them stable, expose clear headers, provide a safe retry pattern, and design writes so retries do not create duplicates. If your limits change, communicate the change early and document it clearly so integrations do not break silently.

Continue exploring with these resources:

<RelatedPosts title="Reliability and safety">
  <RelatedPostCard slug="incident-response-playbook-for-saas-teams" />
  <RelatedPostCard slug="multi-tenant-data-isolation-patterns" />
</RelatedPosts>
