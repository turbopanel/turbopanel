/**
 * The webhook surface's one entrypoint.
 *
 * Both runtimes call this instead of registering each kind by hand, so adding a
 * webhook kind never touches `deno-server.ts` or `workers.ts` again — it is a
 * new adapter plus a line here.
 *
 * **Deliberately not a child router.** Every other surface builds a
 * `new Hono()` and mounts it with `app.route(PREFIX, child)`. This one cannot:
 * the pre-`/webhook` ingress paths live outside the prefix, baked into
 * providers' own settings where only they can change them, and a prefix-mounted
 * router could not serve them. So each gate registers flat paths on the
 * top-level app.
 *
 * **And deliberately no `.use('*')`.** `/webhook` stays out of
 * `PROTECTED_PREFIXES` in `src/browser-write-protection.ts`: session middleware
 * would reject every delivery, and the caller sends no `Origin` for the
 * cross-origin write gate to read. Each gate authenticates itself.
 *
 * Rate limiters are still built by the entrypoints, because the two runtimes
 * source them differently — Redis on Deno, env bindings on Workers.
 */

import type { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import type { RateLimiter } from '../daemon/rate-limit/contracts.ts'
import { registerGithubWebhookRoutes } from './git/github.ts'
import { registerGitlabWebhookRoutes } from './git/gitlab.ts'
import { registerStripeWebhookRoutes } from './billing/stripe.ts'

export type WebhookRouteOpts = {
  /** Runtime, for trusted client-IP resolution. */
  runtime: 'deno' | 'workers'
  /**
   * Per-kind buckets. Separate on purpose: a flood from one sender must not
   * start dropping another's deliveries.
   */
  github?: RateLimiter
  gitlab?: RateLimiter
  /** Billing kind (`/webhook/stripe`) — same gate, its own bucket. */
  stripe?: RateLimiter
}

export function registerWebhookRoutes(
  app: Hono<AppEnv>,
  opts: WebhookRouteOpts,
): Hono<AppEnv> {
  registerGithubWebhookRoutes(app, {
    runtime: opts.runtime,
    ...(opts.github ? { rateLimiter: opts.github } : {}),
  })
  registerGitlabWebhookRoutes(app, {
    runtime: opts.runtime,
    ...(opts.gitlab ? { rateLimiter: opts.gitlab } : {}),
  })
  // Billing exists only in the hosted (Workers) build. Self-hosted Deno is free
  // software with no metering, no tiers and no Stripe — the route is not
  // mounted there at all, not mounted-and-503.
  if (opts.runtime === 'workers') {
    registerStripeWebhookRoutes(app, {
      runtime: opts.runtime,
      ...(opts.stripe ? { rateLimiter: opts.stripe } : {}),
    })
  }
  return app
}
