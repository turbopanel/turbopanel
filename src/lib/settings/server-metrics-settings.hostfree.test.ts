import { assertEquals, assertRejects } from '@std/assert'
import { setting } from '../db/schema.ts'
import type { Db } from '../../db.ts'
import {
  DEFAULT_SERVER_METRICS_LIVE_MAX_MINUTES,
  getServerMetricsLiveMaxMinutes,
  isValidServerMetricsLiveMaxMinutes,
  SERVER_METRICS_LIVE_MAX_MINUTES,
  SERVER_METRICS_LIVE_MIN_MINUTES,
  setServerMetricsLiveMaxMinutes,
} from './server-metrics-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function createFakeSettingDb(initial?: unknown) {
  let stored: unknown = initial
  const db = {
    select() {
      const builder = {
        from() {
          return builder
        },
        where() {
          return builder
        },
        limit(): Promise<Array<{ value: unknown }>> {
          return stored === undefined
            ? Promise.resolve([])
            : Promise.resolve([{ value: stored }])
        },
      }
      return builder
    },
    insert(table: unknown) {
      return {
        values(row: { key: string; value: string }) {
          return {
            onConflictDoUpdate(args: { set: { value: string } }) {
              if (table === setting) stored = args.set.value
              else stored = row.value
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  }
  return db as unknown as Db
}

test('isValidServerMetricsLiveMaxMinutes accepts 0 and the clamp window', () => {
  assertEquals(isValidServerMetricsLiveMaxMinutes(0), true)
  assertEquals(isValidServerMetricsLiveMaxMinutes(SERVER_METRICS_LIVE_MIN_MINUTES), true)
  assertEquals(isValidServerMetricsLiveMaxMinutes(SERVER_METRICS_LIVE_MAX_MINUTES), true)
  assertEquals(isValidServerMetricsLiveMaxMinutes(4), false)
  assertEquals(isValidServerMetricsLiveMaxMinutes(241), false)
  assertEquals(isValidServerMetricsLiveMaxMinutes(1.5), false)
})

test('getServerMetricsLiveMaxMinutes parses a stored string and falls back', async () => {
  assertEquals(
    await getServerMetricsLiveMaxMinutes(createFakeSettingDb('90')),
    90,
  )
  assertEquals(
    await getServerMetricsLiveMaxMinutes(createFakeSettingDb('nope')),
    DEFAULT_SERVER_METRICS_LIVE_MAX_MINUTES,
  )
  assertEquals(
    await getServerMetricsLiveMaxMinutes(createFakeSettingDb({ minutes: 90 })),
    DEFAULT_SERVER_METRICS_LIVE_MAX_MINUTES,
  )
  assertEquals(
    await getServerMetricsLiveMaxMinutes(createFakeSettingDb()),
    DEFAULT_SERVER_METRICS_LIVE_MAX_MINUTES,
  )
})

test('setServerMetricsLiveMaxMinutes rejects values outside the window', async () => {
  const db = createFakeSettingDb()
  await assertRejects(
    () => setServerMetricsLiveMaxMinutes(db, 3),
    TypeError,
    'maxMinutes must be 0 or an integer between 5 and 240',
  )
  await setServerMetricsLiveMaxMinutes(db, 0)
  assertEquals(await getServerMetricsLiveMaxMinutes(db), 0)
})
