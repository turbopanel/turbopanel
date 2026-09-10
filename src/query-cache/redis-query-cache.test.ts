import { assert, assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../db.ts'
import {
  createRedisCellClient,
  type RedisCellClient,
} from '../daemon/cell/redis/client.ts'
import { createRedisQueryCache } from './redis-query-cache.ts'
import { queryCacheKey } from './keys.ts'

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

function withRedisQueryCache(
  fn: (ctx: {
    client: RedisCellClient
    namespace: string
    db: Db
  }) => Promise<void>,
): () => Promise<void> {
  return async () => {
    if (!(await redisAvailable())) {
      console.warn(
        `Skipping Redis query cache test: socket not found at ${DEFAULT_SOCKET}`,
      )
      return
    }

    const client = createRedisCellClient()
    const namespace = `test-${crypto.randomUUID()}`
    const db = null as unknown as Db

    try {
      await fn({ client, namespace, db })
    } finally {
      await client.deleteByPattern(`tp:qcache:${namespace}:*`)
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
  'cached returns loader result on miss then serves from cache on hit',
  withRedisQueryCache(async ({ client, namespace, db }) => {
    const cache = createRedisQueryCache({ client, db })
    const key = queryCacheKey(namespace, 'miss-hit')
    let loadCount = 0
    const listRows = [{
      id: 'srv-1',
      name: 'Test',
      organizationId: 'org-1',
      licenseId: null,
      options: null,
      createdAt: '2024-01-01T00:00:00.000Z',
    }]

    const first = await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 60,
      load: async () => {
        loadCount += 1
        return listRows
      },
    })
    assertEquals(first, listRows)
    assertEquals(loadCount, 1)

    const rawValue = await client.get(key)
    assert(rawValue !== null)
    const parsed = JSON.parse(rawValue!)
    assert(Array.isArray(parsed))
    assertEquals(parsed, listRows)

    const second = await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 60,
      load: async () => {
        loadCount += 1
        return listRows
      },
    })
    assertEquals(second, listRows)
    assertEquals(loadCount, 1)
  }),
)

test(
  'cached clamps ttlSeconds to MAX_QUERY_CACHE_TTL_SECONDS',
  withRedisQueryCache(async ({ client, namespace, db }) => {
    const cache = createRedisQueryCache({ client, db })
    const key = queryCacheKey(namespace, 'ttl-clamp')

    await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 9999,
      load: async () => ({ ok: true }),
    })

    const pttl = await client.pttl(key)
    assert(pttl > 0)
    assert(pttl <= 60_000)
  }),
)

test('cached falls back to loader when Redis get throws', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  const client = {
    get: () => Promise.reject(new Error('redis read failure')),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'servers-list',
    key: queryCacheKey('stub', 'redis-get-error'),
    ttlSeconds: 60,
    load: async () => {
      loadCount += 1
      return { fromLoader: true }
    },
  })

  assertEquals(result, { fromLoader: true })
  assertEquals(loadCount, 1)
})

test('cached returns loader result when Redis set throws', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  let setKey: string | undefined
  const expectedKey = queryCacheKey('servers-list', 'redis-set-error')
  const client = {
    get: () => Promise.resolve(null),
    set: (key: string) => {
      setKey = key
      return Promise.reject(new Error('redis write failure'))
    },
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'servers-list',
    key: expectedKey,
    ttlSeconds: 60,
    load: async () => {
      loadCount += 1
      return { fromLoader: true }
    },
  })

  assertEquals(result, { fromLoader: true })
  assertEquals(loadCount, 1)
  assertEquals(setKey, expectedKey)
  assertEquals(setKey, queryCacheKey('servers-list', 'redis-set-error'))
})

test('getReadModel rejects unapproved read models', async () => {
  const db = null as unknown as Db
  const client = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'not-allowed',
        key: queryCacheKey('stub', 'unapproved'),
        load: async () => ({ ok: true }),
      } as unknown as Parameters<typeof cache.getReadModel>[0]),
    Error,
    'Unapproved read model',
  )
})

test('host-free stub: miss loads then hit serves cached JSON', async () => {
  const db = { kind: 'db' } as unknown as Db
  const store = new Map<string, string>()
  let loadCount = 0
  const client = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: string, _pxMs?: number) => {
      store.set(key, value)
      return Promise.resolve()
    },
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const key = queryCacheKey('servers-list', 'host-free-hit')
  const payload = [{ id: 'srv-1' }]

  const first = await cache.getReadModel({
    readModel: 'servers-list',
    key,
    ttlSeconds: 30,
    load: async (passed) => {
      assertEquals(passed, db)
      loadCount += 1
      return payload
    },
  })
  assertEquals(first, payload)
  assertEquals(loadCount, 1)
  assertEquals(store.get(key), JSON.stringify(payload))

  const second = await cache.getReadModel({
    readModel: 'servers-list',
    key,
    load: async () => {
      loadCount += 1
      return [{ id: 'should-not-load' }]
    },
  })
  assertEquals(second, payload)
  assertEquals(loadCount, 1)
})

test('host-free stub: invalid cached JSON falls back to loader', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  const client = {
    get: () => Promise.resolve('{not-json'),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'server-detail',
    key: queryCacheKey('stub', 'bad-json'),
    load: async () => {
      loadCount += 1
      return { recovered: true }
    },
  })
  assertEquals(result, { recovered: true })
  assertEquals(loadCount, 1)
})

test('host-free stub: clamps ttlSeconds before set', async () => {
  const db = null as unknown as Db
  let seenPx: number | undefined
  const client = {
    get: () => Promise.resolve(null),
    set: (_key: string, _value: string, pxMs?: number) => {
      seenPx = pxMs
      return Promise.resolve()
    },
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  await cache.getReadModel({
    readModel: 'servers-list',
    key: queryCacheKey('stub', 'ttl'),
    ttlSeconds: 9999,
    load: async () => ({ ok: true }),
  })
  assertEquals(seenPx, 60_000)
})

test('host-free stub: omitted ttlSeconds uses the default window', async () => {
  const db = null as unknown as Db
  let seenPx: number | undefined
  const client = {
    get: () => Promise.resolve(null),
    set: (_key: string, _value: string, pxMs?: number) => {
      seenPx = pxMs
      return Promise.resolve()
    },
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  await cache.getReadModel({
    readModel: 'server-detail',
    key: queryCacheKey('stub', 'default-ttl'),
    load: async () => ({ id: 'srv-1' }),
  })
  assertEquals(seenPx, 60_000)
})

test('host-free stub: ttlSeconds 1 is one second in milliseconds', async () => {
  const db = null as unknown as Db
  let seenPx: number | undefined
  const client = {
    get: () => Promise.resolve(null),
    set: (_key: string, _value: string, pxMs?: number) => {
      seenPx = pxMs
      return Promise.resolve()
    },
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  await cache.getReadModel({
    readModel: 'servers-list',
    key: queryCacheKey('stub', 'min-ttl'),
    ttlSeconds: 1,
    load: async () => [],
  })
  assertEquals(seenPx, 1_000)
})

test('host-free stub: empty cached string falls back to loader', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  const client = {
    get: () => Promise.resolve(''),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'servers-list',
    key: queryCacheKey('stub', 'empty-string'),
    load: async () => {
      loadCount += 1
      return [{ recovered: true }]
    },
  })
  assertEquals(result, [{ recovered: true }])
  assertEquals(loadCount, 1)
})

test('host-free stub: JSON null hit does not call load', async () => {
  const db = null as unknown as Db
  let loadCount = 0
  const client = {
    get: () => Promise.resolve('null'),
    set: () => Promise.resolve(),
  } as unknown as RedisCellClient

  const cache = createRedisQueryCache({ client, db })
  const result = await cache.getReadModel({
    readModel: 'server-detail',
    key: queryCacheKey('stub', 'json-null'),
    load: async () => {
      loadCount += 1
      return { shouldNotLoad: true }
    },
  })
  assertEquals(result, null)
  assertEquals(loadCount, 0)
})

test(
  'cached falls back to loader when cached value is invalid JSON',
  withRedisQueryCache(async ({ client, namespace, db }) => {
    const cache = createRedisQueryCache({ client, db })
    const key = queryCacheKey(namespace, 'bad-json')
    await client.set(key, '{not-json')

    let loadCount = 0
    const result = await cache.getReadModel({
      readModel: 'servers-list',
      key,
      ttlSeconds: 60,
      load: async () => {
        loadCount += 1
        return { recovered: true }
      },
    })

    assertEquals(result, { recovered: true })
    assertEquals(loadCount, 1)
  }),
)
