import { assertEquals, assertRejects } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db.ts'
import type { RedisCellClient } from '../../daemon/cell/redis/client.ts'
import { createPassthroughQueryCache } from '../passthrough-query-cache.ts'
import { createRedisQueryCache } from '../redis-query-cache.ts'
import {
  cachedServersListReadModel,
  type ServersListRow,
} from './servers-list.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function directAttachDaemonState() {
  return {
    key: {
      id: 'key-1',
      algorithm: 'Ed25519' as const,
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
      fingerprint: 'fp-1',
      createdAt: '2020-01-01T00:00:00.000Z',
      machineClass: null,
    },
    projection: {
      remoteAddress: '__direct__',
    },
  }
}

function fakeContext(vars: Record<string, unknown>): Context {
  return {
    get: (key: string) => vars[key],
  } as unknown as Context
}

/** Thenable drizzle-shaped terminal that also supports `.orderBy` / `.limit`. */
function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    orderBy: () => promise,
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

/**
 * Host-free Db stub: list-row SELECTs (licenseId field) vs presence SELECTs
 * (daemon/connected fields).
 */
function createStubDb(opts: {
  listRows?: ServersListRow[]
  presenceRows?: Array<{
    id: string
    daemon: unknown
    metadata: unknown
    hostname: string | null
    machineKey: string | null
    connected: boolean
    statusChangedAt: string | null
  }>
}): Db {
  const listRows = opts.listRows ?? []
  const presenceRows = opts.presenceRows ?? []

  return {
    select: (fields: Record<string, unknown>) => {
      const isPresence = 'daemon' in fields || 'connected' in fields
      const rows = isPresence ? presenceRows : listRows
      return {
        from: () => ({
          leftJoin: () => ({
            where: () => thenableRows(rows),
          }),
          where: () => thenableRows(rows),
        }),
      }
    },
  } as unknown as Db
}

test('cachedServersListReadModel rejects when database is missing', async () => {
  await assertRejects(
    () =>
      cachedServersListReadModel(fakeContext({}), {
        userId: 'user-1',
        organizationId: 'org-1',
        visibleIds: ['srv-1'],
      }),
    Error,
    'Database unavailable',
  )
})

test('cachedServersListReadModel returns empty enrichment for empty visible ids', async () => {
  const db = createStubDb({})
  const payload = await cachedServersListReadModel(
    fakeContext({ db }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      visibleIds: [],
    },
  )
  assertEquals(payload, { rows: [], presence: [], colocatedIds: [] })
})

test('cachedServersListReadModel sorts visible ids and enriches from primary db', async () => {
  const listRows: ServersListRow[] = [
    {
      id: 'srv-b',
      name: 'B',
      organizationId: 'org-1',
      licenseId: null,
      options: null,
      createdAt: '2024-01-02T00:00:00.000Z',
      machineClass: null,
    },
    {
      id: 'srv-a',
      name: 'A',
      organizationId: 'org-1',
      licenseId: 'lic-1',
      options: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      machineClass: null,
    },
  ]
  const presenceRows = listRows.map((row) => ({
    id: row.id,
    daemon: null,
    metadata: null,
    hostname: row.name,
    machineKey: null,
    connected: row.id === 'srv-a',
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }))
  const db = createStubDb({ listRows, presenceRows })
  const cache = createPassthroughQueryCache(db)

  const payload = await cachedServersListReadModel(
    fakeContext({ db, queryCache: cache }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      // Unsorted on purpose — key + IN query use localeCompare order.
      visibleIds: ['srv-b', 'srv-a'],
    },
  )

  assertEquals(payload.rows, listRows)
  assertEquals(payload.presence.length, 2)
  assertEquals(
    payload.presence.map((p) => p.serverId).sort((a, b) => a.localeCompare(b)),
    ['srv-a', 'srv-b'],
  )
  assertEquals(Array.isArray(payload.colocatedIds), true)
})

test('cachedServersListReadModel skips enrichment when cached rows are empty', async () => {
  const db = createStubDb({ listRows: [] })
  const cache = createPassthroughQueryCache(db)

  const payload = await cachedServersListReadModel(
    fakeContext({ db, queryCache: cache }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      visibleIds: ['srv-missing'],
    },
  )

  assertEquals(payload, { rows: [], presence: [], colocatedIds: [] })
})

test('cachedServersListReadModel works without query cache in context', async () => {
  const listRows: ServersListRow[] = [{
    id: 'srv-a',
    name: 'A',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }]
  const db = createStubDb({
    listRows,
    presenceRows: [{
      id: 'srv-a',
      daemon: null,
      metadata: null,
      hostname: 'a',
      machineKey: null,
      connected: false,
      statusChangedAt: null,
    }],
  })

  const payload = await cachedServersListReadModel(
    fakeContext({ db }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      visibleIds: ['srv-a'],
    },
  )

  assertEquals(payload.rows, listRows)
  assertEquals(payload.presence.length, 1)
})

test('cachedServersListReadModel marks __direct__ servers as colocated', async () => {
  const listRows: ServersListRow[] = [{
    id: 'srv-colocated',
    name: 'Colocated',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }]
  const presenceRows = [{
    id: 'srv-colocated',
    daemon: directAttachDaemonState(),
    metadata: null,
    hostname: 'colocated',
    machineKey: null,
    connected: true,
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }]
  const db = createStubDb({ listRows, presenceRows })
  const cache = createPassthroughQueryCache(db)

  const payload = await cachedServersListReadModel(
    fakeContext({ db, queryCache: cache }),
    {
      userId: 'user-1',
      organizationId: 'org-1',
      visibleIds: ['srv-colocated'],
    },
  )

  assertEquals(payload.colocatedIds, ['srv-colocated'])
  assertEquals(payload.presence[0]?.connected, true)
})

test('cachedServersListReadModel uses empty visibleIdsKey when visibleIds is empty', async () => {
  const db = createStubDb({})
  const store = new Map<string, string>()
  const cache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })

  const payload = await cachedServersListReadModel(
    fakeContext({ db, queryCache: cache }),
    {
      userId: 'user-1',
      organizationId: 'org-203.0.113.1',
      visibleIds: [],
    },
  )

  assertEquals(payload, { rows: [], presence: [], colocatedIds: [] })
  assertEquals(
    store.has('tp:qcache:servers-list:org-203.0.113.1:'),
    true,
  )
})

test('cachedServersListReadModel uses redis cache key with sorted visible ids', async () => {
  const listRows: ServersListRow[] = [{
    id: 'srv-a',
    name: 'A',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }]
  const db = createStubDb({ listRows, presenceRows: [] })
  const store = new Map<string, string>()
  const cache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })

  const ctx = fakeContext({ db, queryCache: cache })
  const opts = {
    userId: 'user-1',
    organizationId: 'org-1',
    visibleIds: ['srv-b', 'srv-a'],
  }

  const first = await cachedServersListReadModel(ctx, opts)
  assertEquals(first.rows, listRows)
  assertEquals(
    store.has('tp:qcache:servers-list:org-1:srv-a,srv-b'),
    true,
  )

  const second = await cachedServersListReadModel(ctx, opts)
  assertEquals(second.rows, listRows)
})

/**
 * A sealed ProxySQL monitor password used to live on
 * `server.options.managedMonitor`. It now lives on the `monitor` table, but a
 * row written by an older control plane can still carry the key — and this read
 * model both returns `options` to the client and writes it to Redis.
 */
const LEGACY_MONITOR_OPTIONS = {
  timezone: 'UTC',
  managedMonitor: {
    username: 'tp_monitor_0123456789ab',
    passwordSealed: 'tpsecret.v1.deadbeef',
  },
}

test('cachedServersListReadModel never returns a managedMonitor secret', async () => {
  const listRows: ServersListRow[] = [{
    id: 'srv-a',
    name: 'A',
    organizationId: 'org-1',
    licenseId: null,
    options: LEGACY_MONITOR_OPTIONS,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }]
  const db = createStubDb({ listRows, presenceRows: [] })
  const cache = createPassthroughQueryCache(db)

  const payload = await cachedServersListReadModel(
    fakeContext({ db, queryCache: cache }),
    { userId: 'user-1', organizationId: 'org-1', visibleIds: ['srv-a'] },
  )

  // The operator-facing keys survive; the secret does not.
  assertEquals(payload.rows[0]?.options, { timezone: 'UTC' })
  const serialized = JSON.stringify(payload)
  assertEquals(serialized.includes('managedMonitor'), false)
  assertEquals(serialized.includes('passwordSealed'), false)
})

test('cachedServersListReadModel never caches a managedMonitor secret in redis', async () => {
  const listRows: ServersListRow[] = [{
    id: 'srv-a',
    name: 'A',
    organizationId: 'org-1',
    licenseId: null,
    options: LEGACY_MONITOR_OPTIONS,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }]
  const db = createStubDb({ listRows, presenceRows: [] })
  const store = new Map<string, string>()
  const cache = createRedisQueryCache({
    client: {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      set: (key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve()
      },
    } as unknown as RedisCellClient,
    db,
  })

  const ctx = fakeContext({ db, queryCache: cache })
  const opts = {
    userId: 'user-1',
    organizationId: 'org-1',
    visibleIds: ['srv-a'],
  }

  await cachedServersListReadModel(ctx, opts)
  const cached = [...store.values()].join('\n')
  assertEquals(cached.length > 0, true)
  assertEquals(cached.includes('managedMonitor'), false)
  assertEquals(cached.includes('passwordSealed'), false)

  // The second call is served from that cache entry — still no secret.
  const second = await cachedServersListReadModel(ctx, opts)
  assertEquals(second.rows[0]?.options, { timezone: 'UTC' })
  assertEquals(JSON.stringify(second).includes('passwordSealed'), false)
})
