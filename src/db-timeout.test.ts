import { assert, assertEquals, assertRejects } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  type Db,
  DB_OP_TIMEOUT_MS,
  DbOperationTimeoutError,
  endDbConnection,
  getDaemonCellRegistry,
  getDb,
  getQueryCache,
  getServerMetricsStore,
  raceWithTimeout,
  runWithDbTimeout,
} from './db.ts'
import type { Context } from 'hono'
import type { DaemonCellRegistry } from './daemon/cell/contracts.ts'
import type { ServerMetricsStore } from './daemon/metrics/types.ts'
import type { QueryCache } from './query-cache/contracts.ts'

// The projection path never inspects the Db shape when fn ignores it, so a cast
// of a placeholder is sufficient for these timing-focused tests.
const FAKE_DB = {} as Db

it('runWithDbTimeout resolves a fast operation', async () => {
  const result = await runWithDbTimeout(FAKE_DB, () => Promise.resolve('ok'), 1_000)
  assertEquals(result, 'ok')
})

it('runWithDbTimeout rejects a hung operation before the WS lifetime', async () => {
  const start = Date.now()
  const err = await assertRejects(
    () =>
      runWithDbTimeout(
        FAKE_DB,
        // Never resolves — simulates a wedged Hyperdrive round-trip.
        () => new Promise<void>(() => {}),
        50
      ),
    DbOperationTimeoutError
  )
  assert(err.message.includes('50ms'))
  // Must fail fast, not run indefinitely.
  assert(Date.now() - start < 5_000)
})

it('runWithDbTimeout clears its timer so the process can exit', async () => {
  // If the timer were not cleared, Deno's op-sanitizer would fail this test.
  await runWithDbTimeout(FAKE_DB, () => Promise.resolve(42), 10_000)
})

it('runWithDbTimeout swallows a late rejection from the losing race side', async () => {
  // A hung op that later rejects must not surface as an unhandled rejection.
  await assertRejects(
    () =>
      runWithDbTimeout(
        FAKE_DB,
        () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error('late failure')), 30)
          }),
        5
      ),
    DbOperationTimeoutError
  )
  // Give the late rejection time to fire; the swallow-catch must absorb it.
  await new Promise((resolve) => setTimeout(resolve, 60))
})

it('DB_OP_TIMEOUT_MS is a sane hard bound', () => {
  assert(DB_OP_TIMEOUT_MS > 0)
  assert(DB_OP_TIMEOUT_MS <= 15_000)
})

it('runWithDbTimeout uses DB_OP_TIMEOUT_MS when timeout omitted', async () => {
  const result = await runWithDbTimeout(FAKE_DB, () => Promise.resolve('default'))
  assertEquals(result, 'default')
})

it('raceWithTimeout resolves fast work and rejects hung work', async () => {
  assertEquals(await raceWithTimeout(Promise.resolve('ok'), 1_000, 'too slow'), 'ok')

  const err = await assertRejects(
    () => raceWithTimeout(new Promise<void>(() => {}), 20, 'background exceeded'),
    Error,
    'background exceeded'
  )
  assertEquals(err.message, 'background exceeded')
})

it('raceWithTimeout clears its timer and swallows late rejections', async () => {
  await raceWithTimeout(Promise.resolve(1), 10_000, 'unused')
  await assertRejects(
    () =>
      raceWithTimeout(
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error('late')), 30)
        }),
        5,
        'deadline'
      ),
    Error,
    'deadline'
  )
  await new Promise((resolve) => setTimeout(resolve, 60))
})

it('endDbConnection is a no-op for clients without $client', async () => {
  await endDbConnection(FAKE_DB)
})

it('endDbConnection ends a present $client pool', async () => {
  let ended = false
  const db = {
    $client: {
      end: async () => {
        ended = true
      },
    },
  } as unknown as Db
  await endDbConnection(db)
  assertEquals(ended, true)
})

it('context getters read typed Hono variables', () => {
  // Opaque sentinels: the getters under test only read the variable bag, they
  // never touch the stores, so identity is all that has to survive.
  const vars = {
    db: FAKE_DB,
    daemonCellRegistry: { kind: 'registry' } as unknown as DaemonCellRegistry,
    queryCache: { kind: 'cache' } as unknown as QueryCache,
    serverMetricsStore: {
      kind: 'metrics',
    } as unknown as ServerMetricsStore,
  }
  const c = {
    get: (key: string) => vars[key as keyof typeof vars],
  } as unknown as Context

  assertEquals(getDb(c), FAKE_DB)
  assertEquals(getDaemonCellRegistry(c), vars.daemonCellRegistry)
  assertEquals(getQueryCache(c), vars.queryCache)
  assertEquals(getServerMetricsStore(c), vars.serverMetricsStore)

  const empty = { get: () => undefined } as unknown as Context
  assertEquals(getDb(empty), undefined)
  assertEquals(getQueryCache(empty), undefined)
})
