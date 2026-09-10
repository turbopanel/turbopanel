import { assertEquals, assertRejects } from '@std/assert'
import type { Context } from 'hono'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import type { Db } from '../../db.ts'
import type { RedisCellClient } from '../../daemon/cell/redis/client.ts'
import { createHyperdriveQueryCache } from '../hyperdrive-query-cache.ts'
import { createPassthroughQueryCache } from '../passthrough-query-cache.ts'
import { createRedisQueryCache } from '../redis-query-cache.ts'
import {
  cachedServerDetailReadModel,
  type ServerDetailRow,
} from './server-detail.ts'

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

/** Documented cached SELECT #1 column set (see `server-detail.ts` module comment). */
const CACHED_DETAIL_SELECT_KEYS = [
  'createdAt',
  'id',
  'licenseId',
  'machineClass',
  'name',
  'options',
  'organizationId',
]

function createStubDb(opts: {
  detailRows?: ServerDetailRow[]
  presenceRows?: Array<{
    id: string
    daemon: unknown
    metadata: unknown
    hostname: string | null
    machineKey: string | null
    connected: boolean
    statusChangedAt: string | null
  }>
  selectKinds?: string[]
  cachedSelectKeys?: string[][]
}): Db {
  const detailRows = opts.detailRows ?? []
  const presenceRows = opts.presenceRows ?? []

  return {
    select: (fields: Record<string, unknown>) => {
      const isPresence = 'daemon' in fields || 'connected' in fields
      opts.selectKinds?.push(isPresence ? 'presence' : 'cached-row')
      if (!isPresence) {
        opts.cachedSelectKeys?.push(
          Object.keys(fields).sort((a, b) => a.localeCompare(b)),
        )
      }
      const rows = isPresence ? presenceRows : detailRows
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

function cellMustStayAsleep(): DaemonCellRegistry {
  return {
    getCell: () => {
      throw new Error('cached read models must not wake the daemon cell')
    },
    listOnlineServerIds: () =>
      Promise.reject(new Error('cached read models must not list online cells')),
    getSnapshots: () =>
      Promise.reject(new Error('cached read models must not read cell snapshots')),
    purge: () => Promise.reject(new Error('cached read models must not purge cells')),
  }
}

test('cachedServerDetailReadModel rejects when database is missing', async () => {
  await assertRejects(
    () =>
      cachedServerDetailReadModel(fakeContext({}), {
        organizationId: 'org-1',
        serverId: 'srv-1',
      }),
    Error,
    'Database unavailable',
  )
})

test('cachedServerDetailReadModel returns null when the row is missing', async () => {
  const db = createStubDb({ detailRows: [] })
  const result = await cachedServerDetailReadModel(
    fakeContext({ db }),
    { organizationId: 'org-1', serverId: 'srv-missing' },
  )
  assertEquals(result, null)
})

test('cachedServerDetailReadModel returns row plus presence enrichment', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: 'lic-1',
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const presenceRows = [{
    id: 'srv-1',
    daemon: {
      projection: { remoteAddress: '__direct__' },
    },
    metadata: null,
    hostname: 'primary',
    machineKey: null,
    connected: true,
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }]
  const db = createStubDb({ detailRows: [row], presenceRows })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row, row)
  assertEquals(result?.presence?.serverId, 'srv-1')
  assertEquals(result?.presence?.connected, true)
  assertEquals(typeof result?.colocatedWithInstance, 'boolean')
})

test('cachedServerDetailReadModel works without query cache in context', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({
    detailRows: [row],
    presenceRows: [{
      id: 'srv-1',
      daemon: null,
      metadata: null,
      hostname: 'primary',
      machineKey: null,
      connected: false,
      statusChangedAt: null,
    }],
  })

  const result = await cachedServerDetailReadModel(
    fakeContext({ db }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row, row)
  assertEquals(result?.presence?.serverId, 'srv-1')
})

test('cachedServerDetailReadModel reports colocated when projection is __direct__', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const presenceRows = [{
    id: 'srv-1',
    daemon: directAttachDaemonState(),
    metadata: null,
    hostname: 'primary',
    machineKey: null,
    connected: true,
    statusChangedAt: '2024-01-01T00:00:00.000Z',
  }]
  const db = createStubDb({ detailRows: [row], presenceRows })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.colocatedWithInstance, true)
  assertEquals(result?.presence?.connected, true)
})

test('cachedServerDetailReadModel uses redis cache key for org and server', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-203.0.113.2',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [] })
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
  const opts = { organizationId: 'org-203.0.113.2', serverId: 'srv-1' }

  const first = await cachedServerDetailReadModel(ctx, opts)
  assertEquals(first?.row, row)
  assertEquals(
    store.has('tp:qcache:server-detail:org-203.0.113.2:srv-1'),
    true,
  )

  const second = await cachedServerDetailReadModel(ctx, opts)
  assertEquals(second?.row, row)
})

test('cachedServerDetailReadModel returns null presence when preload is empty', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [] })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row, row)
  assertEquals(result?.presence, null)
  assertEquals(result?.colocatedWithInstance, false)
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

test('cachedServerDetailReadModel never returns a managedMonitor secret', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: LEGACY_MONITOR_OPTIONS,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [] })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row.options, { timezone: 'UTC' })
  const serialized = JSON.stringify(result)
  assertEquals(serialized.includes('managedMonitor'), false)
  assertEquals(serialized.includes('passwordSealed'), false)
})

test('cachedServerDetailReadModel never caches a managedMonitor secret in redis', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: LEGACY_MONITOR_OPTIONS,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: null,
  }
  const db = createStubDb({ detailRows: [row], presenceRows: [] })
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
  const opts = { organizationId: 'org-1', serverId: 'srv-1' }

  await cachedServerDetailReadModel(ctx, opts)
  const cached = [...store.values()].join('\n')
  assertEquals(cached.length > 0, true)
  assertEquals(cached.includes('managedMonitor'), false)
  assertEquals(cached.includes('passwordSealed'), false)

  // The second call is served from that cache entry — still no secret.
  const second = await cachedServerDetailReadModel(ctx, opts)
  assertEquals(second?.row.options, { timezone: 'UTC' })
  assertEquals(JSON.stringify(second).includes('passwordSealed'), false)
})

test('cachedServerDetailReadModel cached SELECT includes machineClass', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: 'physical',
  }
  const cachedSelectKeys: string[][] = []
  const db = createStubDb({ detailRows: [row], presenceRows: [], cachedSelectKeys })
  const cache = createPassthroughQueryCache(db)

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  const keys = cachedSelectKeys[0]
  if (!keys) throw new TypeError()
  assertEquals(keys, CACHED_DETAIL_SELECT_KEYS)
  assertEquals(result?.row.machineClass, 'physical')
})

test('cachedServerDetailReadModel runs cached SELECT on Hyperdrive db only', async () => {
  const row: ServerDetailRow = {
    id: 'srv-1',
    name: 'Primary',
    organizationId: 'org-1',
    licenseId: null,
    options: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    machineClass: 'virtual',
  }
  const cachedKinds: string[] = []
  const primaryKinds: string[] = []
  const cachedDb = createStubDb({ detailRows: [row], selectKinds: cachedKinds })
  const primaryDb = createStubDb({
    presenceRows: [{
      id: 'srv-1',
      daemon: null,
      metadata: null,
      hostname: 'primary',
      machineKey: null,
      connected: false,
      statusChangedAt: null,
    }],
    selectKinds: primaryKinds,
  })
  const cache = createHyperdriveQueryCache(cachedDb)

  const result = await cachedServerDetailReadModel(
    fakeContext({
      db: primaryDb,
      queryCache: cache,
      daemonCellRegistry: cellMustStayAsleep(),
    }),
    { organizationId: 'org-1', serverId: 'srv-1' },
  )

  assertEquals(result?.row, row)
  assertEquals(cachedKinds, ['cached-row'])
  assertEquals(primaryKinds, ['presence'])
})

test('cachedServerDetailReadModel redis hit serves JSON null without reloading', async () => {
  const selectKinds: string[] = []
  const db = createStubDb({ detailRows: [], selectKinds })
  const store = new Map<string, string>([
    ['tp:qcache:server-detail:org-1:srv-missing', 'null'],
  ])
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

  const result = await cachedServerDetailReadModel(
    fakeContext({ db, queryCache: cache }),
    { organizationId: 'org-1', serverId: 'srv-missing' },
  )

  assertEquals(result, null)
  assertEquals(selectKinds, [])
})
