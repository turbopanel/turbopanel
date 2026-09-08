/**
 * The grace clock: `grace_expires_at` latches on the first delinquent
 * status, clears on recovery, and the sweep cancels exactly once at expiry.
 */

import { assertEquals } from '@std/assert'
import { payer, subscription } from '../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { createStripeClientDouble } from '../../test-fixtures/stripe-client.ts'
import {
  BILLING_GRACE_WINDOW_MS,
  listGraceExpiredSubscriptions,
  type SubscriptionRow,
  upsertSubscriptionFromProvider,
} from '../db/billing-records.ts'
import {
  GRACE_CLOCK_SWEEP_MINUTE_DIVISOR,
  runGraceClock,
  runGraceClockForSubscription,
  shouldRunGraceClock,
} from './grace-clock.ts'
import { cancelIdempotencyKey } from './subscriptions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const T0 = '2026-09-01T00:00:00.000Z'
const T1 = '2026-09-02T00:00:00.000Z'
const T2 = '2026-09-03T00:00:00.000Z'

async function project(db: ReturnType<typeof createMemoryDb>, status: string, now: string) {
  await upsertSubscriptionFromProvider(db, {
    payerId: PAYER,
    providerSubscriptionId: 'sub_1',
    status,
    currentPeriodEnd: null,
    scheduleId: null,
    now,
  })
  return db.rows<SubscriptionRow>(subscription)[0]!
}

test('grace_expires_at latches on the first past_due and holds through later past_due projections', async () => {
  const db = createMemoryDb([[payer, []], [subscription, []]])
  const first = await project(db, 'past_due', T0)
  assertEquals(first.pastDueSince, T0)
  assertEquals(first.graceExpiresAt, new Date(Date.parse(T0) + BILLING_GRACE_WINDOW_MS).toISOString())
  const again = await project(db, 'past_due', T1)
  assertEquals(again.pastDueSince, T0)
  assertEquals(again.graceExpiresAt, first.graceExpiresAt)
  // `unpaid` is delinquent too: the clock keeps running.
  const unpaid = await project(db, 'unpaid', T2)
  assertEquals(unpaid.graceExpiresAt, first.graceExpiresAt)
})

test('recovery clears both latches so a second lapse starts a fresh window', async () => {
  const db = createMemoryDb([[payer, []], [subscription, []]])
  await project(db, 'past_due', T0)
  const active = await project(db, 'active', T1)
  assertEquals(active.pastDueSince, null)
  assertEquals(active.graceExpiresAt, null)
  const lapsed = await project(db, 'past_due', T2)
  assertEquals(lapsed.pastDueSince, T2)
  assertEquals(lapsed.graceExpiresAt, new Date(Date.parse(T2) + BILLING_GRACE_WINDOW_MS).toISOString())
})

test('an existing latch is used when a row was projected before the clock existed', async () => {
  const db = createMemoryDb([[payer, []], [subscription, [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    payerId: PAYER,
    providerSubscriptionId: 'sub_1',
    status: 'past_due',
    currentPeriodEnd: null,
    scheduleId: null,
    pastDueSince: T0,
    graceExpiresAt: null,
    createdAt: T0,
    updatedAt: T0,
  }]]])
  const row = await project(db, 'past_due', T2)
  // Computed from the original `past_due_since`, not from now.
  assertEquals(row.graceExpiresAt, new Date(Date.parse(T0) + BILLING_GRACE_WINDOW_MS).toISOString())
})

test('the sweep cancels once at expiry with the (subscription, expiry) key, then reprojects', async () => {
  const db = createMemoryDb([[payer, []], [subscription, []]])
  await project(db, 'past_due', T0)
  const expiry = Date.parse(T0) + BILLING_GRACE_WINDOW_MS
  // The precheck GET reports the live Stripe state, which does not move on
  // its own here; only the DELETE flips it.
  const client = createStripeClientDouble((call) => ({ id: 'sub_1', status: call.method === 'DELETE' ? 'canceled' : 'active' }))
  const reprojected: string[] = []
  const deps = { db, client, reproject: (id: string) => Promise.resolve(reprojected.push(id)) }

  // One millisecond early: nothing.
  const early = await runGraceClock({ ...deps, nowMs: expiry - 1 })
  assertEquals(early, { scanned: 0, canceled: [], failed: [] })
  assertEquals(client.calls.length, 0)

  const due = await runGraceClock({ ...deps, nowMs: expiry })
  assertEquals(due.canceled, ['sub_1'])
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/subscriptions/sub_1', 'DELETE /v1/subscriptions/sub_1'])
  assertEquals(
    client.calls[1]!.idempotencyKey,
    cancelIdempotencyKey({ providerSubscriptionId: 'sub_1', graceExpiresAt: new Date(expiry).toISOString() }),
  )
  assertEquals(reprojected, ['sub_1'])

  // The reprojection would have moved the status; simulate it. A second tick is a no-op.
  await project(db, 'canceled', new Date(expiry + 1).toISOString())
  const after = await runGraceClock({ ...deps, nowMs: expiry + 60_000 })
  assertEquals(after.scanned, 0)
  assertEquals(client.calls.length, 2)
})

test('a subscription whose reprojection has not landed yet is retried with the same key, never a new one', async () => {
  const db = createMemoryDb([[payer, []], [subscription, []]])
  await project(db, 'past_due', T0)
  const expiry = Date.parse(T0) + BILLING_GRACE_WINDOW_MS
  // The double never reports canceled on its own, so both ticks see the
  // precheck's GET report "still active" and both DELETE with the same key.
  const client = createStripeClientDouble((call) => ({ id: 'sub_1', status: call.method === 'DELETE' ? 'canceled' : 'active' }))
  const deps = { db, client, reproject: () => Promise.resolve() }
  await runGraceClock({ ...deps, nowMs: expiry })
  await runGraceClock({ ...deps, nowMs: expiry + 1 })
  assertEquals(client.calls.map((c) => c.method), ['GET', 'DELETE', 'GET', 'DELETE'])
  assertEquals(client.calls[1]!.idempotencyKey, client.calls[3]!.idempotencyKey)
  assertEquals((await listGraceExpiredSubscriptions(db, new Date(expiry).toISOString(), 10)).length, 1)
})

test('the scoped clock cancels only the named subscription and leaves every other expired row alone', async () => {
  const db = createMemoryDb([[payer, []], [subscription, []]])
  await project(db, 'past_due', T0)
  await upsertSubscriptionFromProvider(db, {
    payerId: PAYER,
    providerSubscriptionId: 'sub_other',
    status: 'past_due',
    currentPeriodEnd: null,
    scheduleId: null,
    now: T0,
  })
  const expiry = Date.parse(T0) + BILLING_GRACE_WINDOW_MS
  const client = createStripeClientDouble((call) => ({ id: 'sub_1', status: call.method === 'DELETE' ? 'canceled' : 'active' }))
  const reprojected: string[] = []
  const deps = { db, client, reproject: (id: string) => Promise.resolve(reprojected.push(id)) }

  // Both rows are expired; the batch would scan two, the scoped run sees one.
  assertEquals((await listGraceExpiredSubscriptions(db, new Date(expiry).toISOString(), 10)).length, 2)
  const early = await runGraceClockForSubscription({ ...deps, providerSubscriptionId: 'sub_1', nowMs: expiry - 1 })
  assertEquals(early, { scanned: 0, canceled: [], failed: [] })
  const due = await runGraceClockForSubscription({ ...deps, providerSubscriptionId: 'sub_1', nowMs: expiry })
  assertEquals(due, { scanned: 1, canceled: ['sub_1'], failed: [] })
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/subscriptions/sub_1', 'DELETE /v1/subscriptions/sub_1'])
  assertEquals(reprojected, ['sub_1'])
  // A name that matches nothing is a no-op, not an error.
  const none = await runGraceClockForSubscription({ ...deps, providerSubscriptionId: 'sub_missing', nowMs: expiry })
  assertEquals(none, { scanned: 0, canceled: [], failed: [] })
  assertEquals(client.calls.length, 2)
})

test('the divisor predicate fires on the configured minute boundary only', () => {
  const minute = 60_000
  assertEquals(shouldRunGraceClock(0), true)
  assertEquals(shouldRunGraceClock(minute), false)
  assertEquals(shouldRunGraceClock(GRACE_CLOCK_SWEEP_MINUTE_DIVISOR * minute), true)
})
