import { assertEquals } from '@std/assert'
import {
  isStaleCommand,
  STALE_COMMAND_GRACE_MS,
  type StaleCommandCandidate,
} from './stale-sweep.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const T0 = Date.parse('2026-08-29T00:00:00.000Z')

function candidate(overrides: Partial<StaleCommandCandidate>): StaleCommandCandidate {
  return {
    id: '01a04c10-a436-7c38-b64e-e070b3b158fa',
    name: 'managed.apply',
    createdAt: new Date(T0).toISOString(),
    queuedAt: null,
    dispatchStartedAt: null,
    sentAt: null,
    ackedAt: null,
    startedAt: null,
    ...overrides,
  }
}

test('isStaleCommand keeps a running command within its budget', () => {
  const row = candidate({ startedAt: new Date(T0).toISOString() })
  // managed.apply budget is 600s; still inside budget + grace.
  const now = T0 + 600_000 + STALE_COMMAND_GRACE_MS - 1_000
  assertEquals(isStaleCommand(row, now), false)
})

test('isStaleCommand times out a running command past budget + grace', () => {
  const row = candidate({ startedAt: new Date(T0).toISOString() })
  const now = T0 + 600_000 + STALE_COMMAND_GRACE_MS + 1_000
  assertEquals(isStaleCommand(row, now), true)
})

test('isStaleCommand measures from the most recent lifecycle timestamp', () => {
  // Created long ago but only started recently — not stale yet.
  const row = candidate({
    createdAt: new Date(T0 - 3_600_000).toISOString(),
    queuedAt: new Date(T0 - 3_600_000).toISOString(),
    startedAt: new Date(T0).toISOString(),
  })
  const now = T0 + 60_000
  assertEquals(isStaleCommand(row, now), false)
})

test('isStaleCommand handles queued rows that never dispatched', () => {
  const row = candidate({ queuedAt: new Date(T0).toISOString() })
  const now = T0 + 600_000 + STALE_COMMAND_GRACE_MS + 1_000
  assertEquals(isStaleCommand(row, now), true)
})

test('isStaleCommand treats unparseable timestamps as not stale', () => {
  const row = candidate({ createdAt: 'not-a-date' })
  assertEquals(isStaleCommand(row, T0 + 86_400_000), false)
})

test('isStaleCommand falls back through acked, sent, and dispatch timestamps', () => {
  const now = T0 + 600_000 + STALE_COMMAND_GRACE_MS + 1_000
  assertEquals(
    isStaleCommand(
      candidate({
        createdAt: new Date(T0 - 3_600_000).toISOString(),
        ackedAt: new Date(T0).toISOString(),
      }),
      now,
    ),
    true,
  )
  assertEquals(
    isStaleCommand(
      candidate({
        createdAt: new Date(T0 - 3_600_000).toISOString(),
        sentAt: new Date(T0).toISOString(),
      }),
      now,
    ),
    true,
  )
  assertEquals(
    isStaleCommand(
      candidate({
        createdAt: new Date(T0 - 3_600_000).toISOString(),
        dispatchStartedAt: new Date(T0).toISOString(),
      }),
      now,
    ),
    true,
  )
})

test('isStaleCommand respects longer budgets per type', () => {
  // managed.backup budget is 30 minutes — 15 minutes in is not stale.
  const row = candidate({
    name: 'managed.backup',
    startedAt: new Date(T0).toISOString(),
  })
  assertEquals(isStaleCommand(row, T0 + 900_000), false)
  assertEquals(
    isStaleCommand(row, T0 + 1_800_000 + STALE_COMMAND_GRACE_MS + 1_000),
    true,
  )
})
