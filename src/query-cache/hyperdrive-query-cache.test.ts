import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../db.ts'
import { createHyperdriveQueryCache } from './hyperdrive-query-cache.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('hyperdrive cache loads approved models against the cached db', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  let loadTarget: Db | undefined
  const value = await cache.getReadModel({
    readModel: 'servers-list',
    key: 'unused-on-hyperdrive',
    ttlSeconds: 999,
    load: async (passed) => {
      loadTarget = passed
      return [{ id: 'srv-1' }]
    },
  })
  assertEquals(loadTarget, cachedDb)
  assertEquals(value, [{ id: 'srv-1' }])
})

test('hyperdrive cache rejects unapproved read models before load', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  let loaded = false
  await assertRejects(
    () =>
      cache.getReadModel({
        readModel: 'daemon-status',
        key: 'k',
        load: async () => {
          loaded = true
          return null
        },
      } as unknown as Parameters<typeof cache.getReadModel>[0]),
    Error,
    'Unapproved read model for cached database',
  )
  assertEquals(loaded, false)
})

test('hyperdrive cache ignores ttlSeconds and still loads server-detail', async () => {
  const cachedDb = { kind: 'cached' } as unknown as Db
  const cache = createHyperdriveQueryCache(cachedDb)
  const value = await cache.getReadModel({
    readModel: 'server-detail',
    key: 'k',
    ttlSeconds: 1,
    load: async (passed) => {
      assertEquals(passed, cachedDb)
      return { id: 'srv-1' }
    },
  })
  assertEquals(value, { id: 'srv-1' })
})
