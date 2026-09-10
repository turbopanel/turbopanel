/**
 * Deno-only Redis token-bucket RateLimiter.
 * Import **only** from `src/deno.ts` / tests (same containment as
 * `src/query-cache/redis-query-cache.ts`) — never from the Workers bundle.
 */
import type { RedisCellClient } from '../cell/redis/client.ts'
import { rateLimitKey } from '../cell/redis/keys.ts'
import { RATE_LIMIT_TOKEN_BUCKET } from '../cell/redis/lua.ts'
import { logWarn } from '../../logger.ts'
import type { RateLimiter } from './contracts.ts'

/** Defaults match Wrangler `DAEMON_CONNECT_RATE_LIMITER` (`{ limit: 6, period: 60 }`). */
export const DEFAULT_DAEMON_CONNECT_RATE_LIMIT = 6
export const DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS = 60

/** Defaults match Wrangler `DAEMON_REST_RATE_LIMITER` (`{ limit: 30, period: 60 }`). */
export const DEFAULT_DAEMON_REST_RATE_LIMIT = 30
export const DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS = 60

/**
 * Defaults match Wrangler `DAEMON_METRICS_RATE_LIMITER` (`{ limit: 3, period: 60 }`).
 * Daemons send ~1 sample/min; the small burst covers reconnect/retry jitter.
 */
export const DEFAULT_DAEMON_METRICS_RATE_LIMIT = 3
export const DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS = 60

/**
 * Defaults match `SHARED_POLICIES` (`client/authn/auth-rate-limit.ts`) and
 * Wrangler `CLIENT_AUTH_RATE_LIMITER` (`{ limit: 10, period: 60 }`) — the
 * `default` tier in `AUTH_RATE_LIMIT_PURPOSE_TIERS`.
 */
export const DEFAULT_CLIENT_AUTH_RATE_LIMIT = 10
export const DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS = 60

/**
 * Defaults match `SHARED_POLICIES` and Wrangler
 * `CLIENT_AUTH_STRICT_RATE_LIMITER` (`{ limit: 5, period: 60 }`) — the
 * `strict` tier (sign-up, send-otp, reset-password request).
 */
export const DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT = 5
export const DEFAULT_CLIENT_AUTH_STRICT_RATE_PERIOD_SECONDS = 60

/**
 * Defaults match Wrangler `GITHUB_WEBHOOK_RATE_LIMITER` /
 * `GITLAB_WEBHOOK_RATE_LIMITER` (`{ limit: 120, period: 60 }` each).
 * A single `git push` can fan out into a handful of deliveries (push +
 * check_suite + check_run), and an organization-wide App can be pushed to by
 * many repositories at once, so the budget is sized for a legitimate burst.
 * It is an abuse cap, not a pacing mechanism.
 */
export const DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT = 120
export const DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS = 60
/** GitLab's own bucket — same sizing, independent budget. */
export const DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT = 120
export const DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS = 60
/** Stripe delivery volume is far below a push fan-out — a modest budget. */
export const DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT = 60
export const DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS = 60

const MIN_BUCKET_TTL_MS = 1_000

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function resolveDaemonConnectRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_CONNECT_RATE_LIMIT'),
      DEFAULT_DAEMON_CONNECT_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_CONNECT_RATE_PERIOD'),
      DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveDaemonRestRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_REST_RATE_LIMIT'),
      DEFAULT_DAEMON_REST_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_REST_RATE_PERIOD'),
      DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveDaemonMetricsRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_METRICS_RATE_LIMIT'),
      DEFAULT_DAEMON_METRICS_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_METRICS_RATE_PERIOD'),
      DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveClientAuthRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_CLIENT_AUTH_RATE_LIMIT'),
      DEFAULT_CLIENT_AUTH_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_CLIENT_AUTH_RATE_PERIOD'),
      DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveClientAuthStrictRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_CLIENT_AUTH_STRICT_RATE_LIMIT'),
      DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_CLIENT_AUTH_STRICT_RATE_PERIOD'),
      DEFAULT_CLIENT_AUTH_STRICT_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveGithubWebhookRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_GITHUB_WEBHOOK_RATE_LIMIT'),
      DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_GITHUB_WEBHOOK_RATE_PERIOD'),
      DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveGitlabWebhookRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_GITLAB_WEBHOOK_RATE_LIMIT'),
      DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_GITLAB_WEBHOOK_RATE_PERIOD'),
      DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveStripeWebhookRateLimit(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; periodSeconds: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_STRIPE_WEBHOOK_RATE_LIMIT'),
      DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT,
    ),
    periodSeconds: parsePositiveIntEnv(
      env.get('TURBOPANEL_STRIPE_WEBHOOK_RATE_PERIOD'),
      DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS,
    ),
  }
}

export function resolveDaemonWsInboundLimits(env: {
  get(key: string): string | undefined
} = Deno.env): { limit: number; windowMs: number } {
  return {
    limit: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_WS_INBOUND_LIMIT'),
      120,
    ),
    windowMs: parsePositiveIntEnv(
      env.get('TURBOPANEL_DAEMON_WS_INBOUND_WINDOW_MS'),
      60_000,
    ),
  }
}

export function createLocalTokenBucketLimiter(opts: {
  limit: number
  periodSeconds: number
}): RateLimiter {
  const buckets = new Map<string, { tokens: number; lastMs: number }>()
  const capacity = opts.limit
  const msPerToken = (opts.periodSeconds * 1000) / opts.limit

  return {
    async limit(args: { key: string }): Promise<{ success: boolean }> {
      const now = Date.now()
      let bucket = buckets.get(args.key)
      if (!bucket) {
        bucket = { tokens: capacity, lastMs: now }
        buckets.set(args.key, bucket)
      }
      const elapsed = now - bucket.lastMs
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed / msPerToken)
      bucket.lastMs = now
      if (bucket.tokens < 1) return { success: false }
      bucket.tokens -= 1
      return { success: true }
    },
  }
}

export function createRedisRateLimiter(opts: {
  client: RedisCellClient
  limit: number
  periodSeconds: number
  /**
   * Behaviour when Redis `eval` throws.
   * - `'open'` (default): allow the request — used for daemon connect/REST so a
   *   broker hiccup never locks out enrolled daemons.
   * - `'closed'`: deny (`success: false`) — required for client-auth throttling
   *   so Redis failure cannot fail open into unthrottled login/OTP/install.
   * - `'local'`: fall through to a process-local token bucket with the same
   *   limit/period. Used for webhook ingress so a Redis blip still throttles
   *   per peer instead of making the surface unlimited.
   */
  onError?: 'open' | 'closed' | 'local'
}): RateLimiter {
  const capacity = opts.limit
  const msPerToken = (opts.periodSeconds * 1000) / opts.limit
  const ttlMs = Math.max(
    Math.ceil(capacity * msPerToken),
    MIN_BUCKET_TTL_MS,
  )
  const { client } = opts
  const onError = opts.onError ?? 'open'
  const local = onError === 'local'
    ? createLocalTokenBucketLimiter({
      limit: opts.limit,
      periodSeconds: opts.periodSeconds,
    })
    : null

  return {
    async limit(args: { key: string }): Promise<{ success: boolean }> {
      try {
        const result = await client.eval(
          RATE_LIMIT_TOKEN_BUCKET,
          1,
          rateLimitKey(args.key),
          capacity,
          msPerToken,
          Date.now(),
          ttlMs,
        )
        return { success: result === 1 }
      } catch (err) {
        logWarn(
          'daemon-rate-limit',
          `eval failed for ${args.key}: ${String(err)}`,
        )
        if (local) return await local.limit(args)
        return { success: onError === 'open' }
      }
    },
  }
}
