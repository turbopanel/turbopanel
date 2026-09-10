import { assertEquals } from '@std/assert'
import {
  createRedisCellClient,
  type RedisCellClient,
} from '../cell/redis/client.ts'
import { rateLimitKey } from '../cell/redis/keys.ts'
import {
  createRedisRateLimiter,
  DEFAULT_CLIENT_AUTH_RATE_LIMIT,
  DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS,
  DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT,
  DEFAULT_CLIENT_AUTH_STRICT_RATE_PERIOD_SECONDS,
  DEFAULT_DAEMON_CONNECT_RATE_LIMIT,
  DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS,
  DEFAULT_DAEMON_METRICS_RATE_LIMIT,
  DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS,
  DEFAULT_DAEMON_REST_RATE_LIMIT,
  DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
  DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT,
  DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS,
  DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT,
  DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS,
  DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT,
  DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS,
  resolveClientAuthRateLimit,
  resolveClientAuthStrictRateLimit,
  resolveDaemonConnectRateLimit,
  resolveDaemonMetricsRateLimit,
  resolveDaemonRestRateLimit,
  resolveDaemonWsInboundLimits,
  resolveGithubWebhookRateLimit,
  resolveGitlabWebhookRateLimit,
  resolveStripeWebhookRateLimit,
} from './redis-rate-limiter.ts'
import {
  daemonConnectRateLimitKey,
  daemonRestRateLimitKey,
} from './keys.ts'

const DEFAULT_SOCKET = Deno.env.get('TURBOPANEL_REDIS_SOCKET') ??
  '/run/turbopanel/redis.sock'

async function redisAvailable(): Promise<boolean> {
  try {
    const stat = await Deno.stat(DEFAULT_SOCKET)
    return stat.isSocket === true
  } catch {
    return false
  }
}

function withRedis(
  fn: (client: RedisCellClient) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping Redis rate-limiter test: socket not found at ${DEFAULT_SOCKET}`,
      )
      return
    }

    const client = createRedisCellClient()
    try {
      await fn(client)
    } finally {
      await client.close()
    }
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test(
  'redis rate limiter allows up to limit then denies for a key',
  withRedis(async (client) => {
    const key = `test-limit-${crypto.randomUUID()}`
    const storageKey = rateLimitKey(key)
    const limiter = createRedisRateLimiter({
      client,
      limit: 2,
      periodSeconds: 60,
    })
    try {
      assertEquals(await limiter.limit({ key }), { success: true })
      assertEquals(await limiter.limit({ key }), { success: true })
      assertEquals(await limiter.limit({ key }), { success: false })
    } finally {
      await client.del(storageKey)
    }
  }),
)

test(
  'redis rate limiter treats distinct keys independently',
  withRedis(async (client) => {
    const keyA = `test-a-${crypto.randomUUID()}`
    const keyB = `test-b-${crypto.randomUUID()}`
    const limiter = createRedisRateLimiter({
      client,
      limit: 1,
      periodSeconds: 60,
    })
    try {
      assertEquals(await limiter.limit({ key: keyA }), { success: true })
      assertEquals(await limiter.limit({ key: keyA }), { success: false })
      assertEquals(await limiter.limit({ key: keyB }), { success: true })
      assertEquals(await limiter.limit({ key: keyB }), { success: false })
    } finally {
      await client.del(rateLimitKey(keyA), rateLimitKey(keyB))
    }
  }),
)

test(
  'redis rate limiter refills capacity over time',
  withRedis(async (client) => {
    const key = `test-refill-${crypto.randomUUID()}`
    const limiter = createRedisRateLimiter({
      client,
      limit: 1,
      periodSeconds: 1,
    })
    try {
      assertEquals(await limiter.limit({ key }), { success: true })
      assertEquals(await limiter.limit({ key }), { success: false })
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      assertEquals(await limiter.limit({ key }), { success: true })
    } finally {
      await client.del(rateLimitKey(key))
    }
  }),
)

test(
  'redis rate limiter stores under tp:ratelimit:* namespace',
  withRedis(async (client) => {
    const logical = daemonConnectRateLimitKey(`test-${crypto.randomUUID()}`)
    const storageKey = rateLimitKey(logical)
    const limiter = createRedisRateLimiter({
      client,
      limit: 1,
      periodSeconds: 60,
    })
    try {
      assertEquals(await limiter.limit({ key: logical }), { success: true })
      const hash = await client.hgetall(storageKey)
      assertEquals(hash !== null && hash.tokens !== undefined, true)
      assertEquals(storageKey.startsWith('tp:ratelimit:'), true)
      assertEquals(storageKey, `tp:ratelimit:${logical}`)
    } finally {
      await client.del(storageKey)
    }
  }),
)

test('createRedisRateLimiter fails open when eval throws (daemon default)', async () => {
  const badClient = {
    eval: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisCellClient
  const limiter = createRedisRateLimiter({
    client: badClient,
    limit: 1,
    periodSeconds: 60,
  })
  assertEquals(await limiter.limit({ key: 'any' }), { success: true })
})

test('createRedisRateLimiter fails closed when onError is closed', async () => {
  const badClient = {
    eval: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisCellClient
  const limiter = createRedisRateLimiter({
    client: badClient,
    limit: 1,
    periodSeconds: 60,
    onError: 'closed',
  })
  assertEquals(await limiter.limit({ key: 'auth-key' }), { success: false })
})

test('createRedisRateLimiter falls back to a local bucket when onError is local', async () => {
  const badClient = {
    eval: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisCellClient
  const limiter = createRedisRateLimiter({
    client: badClient,
    limit: 1,
    periodSeconds: 60,
    onError: 'local',
  })
  assertEquals(await limiter.limit({ key: 'peer-a' }), { success: true })
  assertEquals(await limiter.limit({ key: 'peer-a' }), { success: false })
  assertEquals(await limiter.limit({ key: 'peer-b' }), { success: true })
})

test('createRedisRateLimiter satisfies RateLimiter with shared keys', async () => {
  const seen: string[] = []
  const client = {
    eval: (
      _script: string,
      _numkeys: number,
      storageKey: string | number,
    ) => {
      seen.push(String(storageKey))
      return Promise.resolve(1)
    },
  } as unknown as RedisCellClient

  const limiter = createRedisRateLimiter({
    client,
    limit: 6,
    periodSeconds: 60,
  })
  const connectKey = daemonConnectRateLimitKey('srv-1')
  const restKey = daemonRestRateLimitKey('srv-1', 'auth-session')
  assertEquals(await limiter.limit({ key: connectKey }), { success: true })
  assertEquals(await limiter.limit({ key: restKey }), { success: true })
  assertEquals(seen, [
    rateLimitKey(connectKey),
    rateLimitKey(restKey),
  ])
})

test('resolveDaemonConnectRateLimit / REST / metrics defaults match Workers wrangler', () => {
  const empty = { get: () => undefined }
  assertEquals(resolveDaemonConnectRateLimit(empty), {
    limit: DEFAULT_DAEMON_CONNECT_RATE_LIMIT,
    periodSeconds: DEFAULT_DAEMON_CONNECT_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveDaemonRestRateLimit(empty), {
    limit: DEFAULT_DAEMON_REST_RATE_LIMIT,
    periodSeconds: DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveDaemonMetricsRateLimit(empty), {
    limit: DEFAULT_DAEMON_METRICS_RATE_LIMIT,
    periodSeconds: DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS,
  })
})

test('resolveDaemon*RateLimit reads env overrides and ignores invalid values', () => {
  const env = {
    get: (key: string) => {
      const values: Record<string, string> = {
        TURBOPANEL_DAEMON_CONNECT_RATE_LIMIT: '12',
        TURBOPANEL_DAEMON_CONNECT_RATE_PERIOD: '120',
        TURBOPANEL_DAEMON_REST_RATE_LIMIT: '0',
        TURBOPANEL_DAEMON_REST_RATE_PERIOD: 'not-a-number',
        TURBOPANEL_DAEMON_METRICS_RATE_LIMIT: '-3',
        TURBOPANEL_DAEMON_METRICS_RATE_PERIOD: '',
      }
      return values[key]
    },
  }
  assertEquals(resolveDaemonConnectRateLimit(env), {
    limit: 12,
    periodSeconds: 120,
  })
  assertEquals(resolveDaemonRestRateLimit(env), {
    limit: DEFAULT_DAEMON_REST_RATE_LIMIT,
    periodSeconds: DEFAULT_DAEMON_REST_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveDaemonMetricsRateLimit(env), {
    limit: DEFAULT_DAEMON_METRICS_RATE_LIMIT,
    periodSeconds: DEFAULT_DAEMON_METRICS_RATE_PERIOD_SECONDS,
  })
})

test('resolveDaemonWsInboundLimits defaults and env overrides', () => {
  assertEquals(resolveDaemonWsInboundLimits({ get: () => undefined }), {
    limit: 120,
    windowMs: 60_000,
  })
  assertEquals(
    resolveDaemonWsInboundLimits({
      get: (key) =>
        key === 'TURBOPANEL_DAEMON_WS_INBOUND_LIMIT' ? '90' : '45000',
    }),
    { limit: 90, windowMs: 45_000 },
  )
})

test('resolveGithub/Gitlab/Stripe webhook rate limits default and env overrides', () => {
  const empty = { get: () => undefined }
  assertEquals(resolveGithubWebhookRateLimit(empty), {
    limit: DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT,
    periodSeconds: DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveGitlabWebhookRateLimit(empty), {
    limit: DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT,
    periodSeconds: DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveStripeWebhookRateLimit(empty), {
    limit: DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT,
    periodSeconds: DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS,
  })

  const env = {
    get: (key: string) => {
      const values: Record<string, string> = {
        TURBOPANEL_GITHUB_WEBHOOK_RATE_LIMIT: '80',
        TURBOPANEL_GITHUB_WEBHOOK_RATE_PERIOD: '30',
        TURBOPANEL_GITLAB_WEBHOOK_RATE_LIMIT: '90',
        TURBOPANEL_GITLAB_WEBHOOK_RATE_PERIOD: '45',
        TURBOPANEL_STRIPE_WEBHOOK_RATE_LIMIT: '20',
        TURBOPANEL_STRIPE_WEBHOOK_RATE_PERIOD: '15',
      }
      return values[key]
    },
  }
  assertEquals(resolveGithubWebhookRateLimit(env), {
    limit: 80,
    periodSeconds: 30,
  })
  assertEquals(resolveGitlabWebhookRateLimit(env), {
    limit: 90,
    periodSeconds: 45,
  })
  assertEquals(resolveStripeWebhookRateLimit(env), {
    limit: 20,
    periodSeconds: 15,
  })
})

test('webhook rate limit resolvers ignore non-positive env values', () => {
  const env = {
    get: () => '0',
  }
  assertEquals(resolveGithubWebhookRateLimit(env), {
    limit: DEFAULT_GITHUB_WEBHOOK_RATE_LIMIT,
    periodSeconds: DEFAULT_GITHUB_WEBHOOK_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveGitlabWebhookRateLimit(env), {
    limit: DEFAULT_GITLAB_WEBHOOK_RATE_LIMIT,
    periodSeconds: DEFAULT_GITLAB_WEBHOOK_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveStripeWebhookRateLimit(env), {
    limit: DEFAULT_STRIPE_WEBHOOK_RATE_LIMIT,
    periodSeconds: DEFAULT_STRIPE_WEBHOOK_RATE_PERIOD_SECONDS,
  })
})

test('resolveClientAuthRateLimit / resolveClientAuthStrictRateLimit defaults match SHARED_POLICIES', () => {
  const empty = { get: () => undefined }
  assertEquals(resolveClientAuthRateLimit(empty), {
    limit: DEFAULT_CLIENT_AUTH_RATE_LIMIT,
    periodSeconds: DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveClientAuthStrictRateLimit(empty), {
    limit: DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT,
    periodSeconds: DEFAULT_CLIENT_AUTH_STRICT_RATE_PERIOD_SECONDS,
  })
  // Strict must actually be stricter than default — the whole point of the tier.
  assertEquals(DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT < DEFAULT_CLIENT_AUTH_RATE_LIMIT, true)
})

test('resolveClientAuth*RateLimit reads env overrides independently', () => {
  const env = {
    get: (key: string) => {
      const values: Record<string, string> = {
        TURBOPANEL_CLIENT_AUTH_RATE_LIMIT: '15',
        TURBOPANEL_CLIENT_AUTH_STRICT_RATE_LIMIT: '3',
        TURBOPANEL_CLIENT_AUTH_STRICT_RATE_PERIOD: '30',
      }
      return values[key]
    },
  }
  assertEquals(resolveClientAuthRateLimit(env), {
    limit: 15,
    periodSeconds: DEFAULT_CLIENT_AUTH_RATE_PERIOD_SECONDS,
  })
  assertEquals(resolveClientAuthStrictRateLimit(env), {
    limit: 3,
    periodSeconds: 30,
  })
})

test(
  'a strict-tier durable Redis limiter blocks at 5 attempts, independent from the default-tier bucket',
  withRedis(async (client) => {
    const key = `test-strict-${crypto.randomUUID()}`
    const defaultKey = `test-default-${crypto.randomUUID()}`
    const strictLimiter = createRedisRateLimiter({
      client,
      limit: DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT,
      periodSeconds: 60,
    })
    const defaultLimiter = createRedisRateLimiter({
      client,
      limit: DEFAULT_CLIENT_AUTH_RATE_LIMIT,
      periodSeconds: 60,
    })
    try {
      for (let i = 0; i < DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT; i++) {
        assertEquals(await strictLimiter.limit({ key }), { success: true })
      }
      assertEquals(await strictLimiter.limit({ key }), { success: false })

      // The default-tier bucket for the same purpose family is untouched —
      // separate instances, separate budgets.
      for (let i = 0; i < DEFAULT_CLIENT_AUTH_STRICT_RATE_LIMIT; i++) {
        assertEquals(await defaultLimiter.limit({ key: defaultKey }), { success: true })
      }
      assertEquals(await defaultLimiter.limit({ key: defaultKey }), { success: true })
    } finally {
      await client.del(rateLimitKey(key), rateLimitKey(defaultKey))
    }
  }),
)

test('createRedisRateLimiter denies when eval returns non-one', async () => {
  const client = {
    eval: () => Promise.resolve(0),
  } as unknown as RedisCellClient
  const limiter = createRedisRateLimiter({
    client,
    limit: 2,
    periodSeconds: 60,
  })
  assertEquals(await limiter.limit({ key: 'deny' }), { success: false })
})
