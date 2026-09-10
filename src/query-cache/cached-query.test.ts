import { assertEquals } from '@std/assert'
import type { Db } from '../db.ts'
import type { ApprovedReadModelCacheOpts } from './contracts.ts'
import { runApprovedCachedReadModel } from './cached-query.ts'
import { createPassthroughQueryCache } from './passthrough-query-cache.ts'
import { queryCacheKey } from './keys.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createRecordingCache(db: Db) {
  const calls: ApprovedReadModelCacheOpts<unknown>[] = []
  const cache = {
    getReadModel: async <T>(opts: ApprovedReadModelCacheOpts<T>): Promise<T> => {
      calls.push(opts as ApprovedReadModelCacheOpts<unknown>)
      return opts.load(db)
    },
  }
  return { cache, calls }
}

test('runApprovedCachedReadModel builds queryCacheKey from read model and parts', async () => {
  const db = { kind: 'db' } as unknown as Db
  const { cache, calls } = createRecordingCache(db)

  await runApprovedCachedReadModel(
    cache,
    db,
    'servers-list',
    ['org-203.0.113.1', 'srv-a,srv-b'],
    async () => [{ id: 'srv-a' }],
    45,
  )

  assertEquals(calls.length, 1)
  assertEquals(
    calls[0]?.key,
    queryCacheKey('servers-list', 'org-203.0.113.1', 'srv-a,srv-b'),
  )
  assertEquals(calls[0]?.readModel, 'servers-list')
  assertEquals(calls[0]?.ttlSeconds, 45)
})

test('runApprovedCachedReadModel defaults ttl when omitted', async () => {
  const db = { kind: 'db' } as unknown as Db
  const { cache, calls } = createRecordingCache(db)

  await runApprovedCachedReadModel(
    cache,
    db,
    'server-detail',
    ['org-1', 'srv-1'],
    async () => null,
  )

  assertEquals(calls[0]?.ttlSeconds, 60)
  assertEquals(
    calls[0]?.key,
    queryCacheKey('server-detail', 'org-1', 'srv-1'),
  )
})

test('runApprovedCachedReadModel passes readDb from cache backend to load', async () => {
  const primaryDb = { kind: 'primary' } as unknown as Db
  const readDb = { kind: 'cached' } as unknown as Db
  let loadTarget: Db | undefined
  const cache = {
    getReadModel: async <T>(opts: ApprovedReadModelCacheOpts<T>): Promise<T> => {
      return opts.load(readDb)
    },
  }

  const value = await runApprovedCachedReadModel(
    cache,
    primaryDb,
    'servers-list',
    ['org-1', 'srv-1'],
    async (passed) => {
      loadTarget = passed
      return [{ id: 'srv-1' }]
    },
  )

  assertEquals(loadTarget, readDb)
  assertEquals(value, [{ id: 'srv-1' }])
})

test('runApprovedCachedReadModel uses passthrough cache integration', async () => {
  const db = { kind: 'passthrough' } as unknown as Db
  const cache = createPassthroughQueryCache(db)
  const loaded = await runApprovedCachedReadModel(
    cache,
    db,
    'servers-list',
    ['org-1'],
    async (passed) => {
      assertEquals(passed, db)
      return ['row']
    },
  )
  assertEquals(loaded, ['row'])
})

test('runApprovedCachedReadModel joins an empty key-parts list', async () => {
  const db = { kind: 'db' } as unknown as Db
  const { cache, calls } = createRecordingCache(db)

  await runApprovedCachedReadModel(
    cache,
    db,
    'servers-list',
    [],
    async () => [],
  )

  const call = calls[0]
  if (!call) throw new TypeError()
  assertEquals(call.key, queryCacheKey('servers-list'))
})
