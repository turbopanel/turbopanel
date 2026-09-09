/**
 * Deferred changes via subscription schedules: every phase resent on
 * update, release before an immediate change, the future phase rebuilt
 * from the whole intent ledger, and items spelled as `price` + `quantity`.
 */

import { assertEquals, assertThrows } from '@std/assert'
import { createStripeClientDouble, formKeys, formOf, type StripeCall } from '../../test-fixtures/stripe-client.ts'
import { deferredDeltasByTier, emptyLedger, newDeferredIntent, withIntent } from './pending-changes.ts'
import {
  buildSchedulePhasesParam,
  computeDeferredItems,
  mutateSubscription,
  parseSchedule,
  syncDeferredSchedule,
} from './schedules.ts'
import type { SeatLine } from './subscriptions.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const PRICES = new Map([[S3, 'price_s3'], [S5, 'price_s5']])
const CURRENT: SeatLine[] = [
  { providerItemId: 'si_3', providerPriceId: 'price_s3', tierId: S3, quantity: 2 },
  { providerItemId: 'si_5', providerPriceId: 'price_s5', tierId: S5, quantity: 2 },
]
const PERIOD_START = 1_756_684_800
const PERIOD_END = 1_759_276_800

const SCHEDULE_FROM_STRIPE = {
  id: 'sub_sched_1',
  status: 'active',
  subscription: 'sub_1',
  phases: [
    {
      start_date: PERIOD_START,
      end_date: PERIOD_END,
      items: [{ price: 'price_s3', quantity: 2 }, { price: { id: 'price_s5' }, quantity: 2 }],
    },
  ],
}

function scheduleResponder(calls: string[]) {
  return (call: StripeCall) => {
    calls.push(`${call.method} ${call.path}`)
    if (call.path === '/v1/subscription_schedules' || call.path.startsWith('/v1/subscription_schedules/sub_sched_1')) {
      return SCHEDULE_FROM_STRIPE
    }
    if (call.path === '/v1/subscriptions/sub_1' && call.method === 'GET') {
      return { id: 'sub_1', items: { data: [{ id: 'si_3', price: { id: 'price_s3' }, quantity: 3 }, { id: 'si_5', price: { id: 'price_s5' }, quantity: 1 }] } }
    }
    return { id: 'sub_1', status: 'active', pending_update: null }
  }
}

test('computeDeferredItems applies every outstanding intent from scratch and drops zero tiers', () => {
  let ledger = emptyLedger('sub_1')
  ledger = withIntent(ledger, newDeferredIntent('downgrade', { fromTierId: S5, toTierId: S3, landsAt: null, fromQuantity: 2 }))
  ledger = withIntent(ledger, newDeferredIntent('downgrade', { fromTierId: S5, toTierId: S3, landsAt: null, fromQuantity: 2 }))
  const items = computeDeferredItems(CURRENT, deferredDeltasByTier(ledger), PRICES)
  // Two stacked downgrades: S5 2 → 0 (dropped), S3 2 → 4. No incremental patch.
  assertEquals(items, [{ price: 'price_s3', quantity: 4 }])
  assertThrows(() => computeDeferredItems(CURRENT, new Map([[S5, -3]]), PRICES), RangeError)
})

test('buildSchedulePhasesParam restates the current phase with its dates and appends one contiguous period', () => {
  const phases = buildSchedulePhasesParam(
    { startDate: PERIOD_START, endDate: PERIOD_END, items: [{ price: 'price_s3', quantity: 2 }] },
    [{ price: 'price_s3', quantity: 1 }],
  )
  assertEquals(phases, [
    { start_date: PERIOD_START, end_date: PERIOD_END, items: [{ price: 'price_s3', quantity: 2 }] },
    { start_date: PERIOD_END, duration: { interval: 'month', interval_count: 1 }, items: [{ price: 'price_s3', quantity: 1 }] },
  ])
  assertThrows(() => buildSchedulePhasesParam({ startDate: 1, endDate: null, items: [] }, []), TypeError)
  // No future items: the current phase stands alone (a phase with no items is refused by Stripe).
  assertEquals(
    buildSchedulePhasesParam({ startDate: PERIOD_START, endDate: PERIOD_END, items: [{ price: 'price_s3', quantity: 2 }] }, []),
    [{ start_date: PERIOD_START, end_date: PERIOD_END, items: [{ price: 'price_s3', quantity: 2 }] }],
  )
})

test('syncDeferredSchedule with every seat given back writes the current phase alone and cancels at its end', async () => {
  const calls: string[] = []
  const client = createStripeClientDouble(scheduleResponder(calls))
  const out = await syncDeferredSchedule(client, {
    providerSubscriptionId: 'sub_1',
    scheduleId: 'sub_sched_1',
    current: CURRENT,
    deltasByTier: new Map([[S3, -2], [S5, -2]]),
    priceByTier: PRICES,
    idempotencyKey: 'intent-4',
  })
  assertEquals(out.scheduleId, 'sub_sched_1')
  assertEquals(calls, ['GET /v1/subscription_schedules/sub_sched_1', 'POST /v1/subscription_schedules/sub_sched_1'])
  const update = client.calls[1]!
  // Paid-for until the boundary: the current phase is restated unchanged…
  assertEquals(formOf(update, 'phases[0][start_date]'), String(PERIOD_START))
  assertEquals(formOf(update, 'phases[0][end_date]'), String(PERIOD_END))
  assertEquals(formOf(update, 'phases[0][items][0][quantity]'), '2')
  assertEquals(formOf(update, 'phases[0][items][1][quantity]'), '2')
  // …no second phase is sent, and the schedule ends by cancelling the subscription.
  assertEquals(formKeys(update).some((k) => k.startsWith('phases[1]')), false)
  assertEquals(formOf(update, 'end_behavior'), 'cancel')
  // Never `preserve_cancel_date`: a later release must drop the cancellation.
  assertEquals(formKeys(update).includes('preserve_cancel_date'), false)
})

test('parseSchedule normalises expanded and bare price references', () => {
  const parsed = parseSchedule(SCHEDULE_FROM_STRIPE)
  assertEquals(parsed.id, 'sub_sched_1')
  assertEquals(parsed.providerSubscriptionId, 'sub_1')
  assertEquals(parsed.phases[0]?.items, [{ price: 'price_s3', quantity: 2 }, { price: 'price_s5', quantity: 2 }])
})

test('syncDeferredSchedule creates from the subscription, then resends every phase with price + quantity items', async () => {
  const calls: string[] = []
  const client = createStripeClientDouble(scheduleResponder(calls))
  const out = await syncDeferredSchedule(client, {
    providerSubscriptionId: 'sub_1',
    scheduleId: null,
    current: CURRENT,
    deltasByTier: new Map([[S5, -1], [S3, 1]]),
    priceByTier: PRICES,
    idempotencyKey: 'intent-1',
  })
  assertEquals(out.scheduleId, 'sub_sched_1')
  assertEquals(calls, ['POST /v1/subscription_schedules', 'POST /v1/subscription_schedules/sub_sched_1'])
  const [create, update] = client.calls
  assertEquals(formOf(create!, 'from_subscription'), 'sub_1')
  assertEquals(create!.idempotencyKey, 'intent-1:schedule')
  assertEquals(update!.idempotencyKey, 'intent-1:phases')
  // Both phases are present, the current one with its own dates.
  assertEquals(formOf(update!, 'phases[0][start_date]'), String(PERIOD_START))
  assertEquals(formOf(update!, 'phases[0][end_date]'), String(PERIOD_END))
  assertEquals(formOf(update!, 'phases[0][items][0][price]'), 'price_s3')
  assertEquals(formOf(update!, 'phases[0][items][0][quantity]'), '2')
  assertEquals(formOf(update!, 'phases[1][start_date]'), String(PERIOD_END))
  assertEquals(formOf(update!, 'phases[1][duration][interval]'), 'month')
  assertEquals(formOf(update!, 'phases[1][duration][interval_count]'), '1')
  assertEquals(formOf(update!, 'phases[1][items][0][price]'), 'price_s3')
  assertEquals(formOf(update!, 'phases[1][items][0][quantity]'), '3')
  assertEquals(formOf(update!, 'phases[1][items][1][price]'), 'price_s5')
  assertEquals(formOf(update!, 'phases[1][items][1][quantity]'), '1')
  assertEquals(formOf(update!, 'end_behavior'), 'release')
  // Never `items[n][id]` / `deleted` on a phase.
  assertEquals(formKeys(update!).some((k) => k.includes('[id]') || k.includes('[deleted]')), false)
})

test('syncDeferredSchedule reuses an attached schedule and releases it when nothing is deferred', async () => {
  const calls: string[] = []
  const client = createStripeClientDouble(scheduleResponder(calls))
  await syncDeferredSchedule(client, {
    providerSubscriptionId: 'sub_1',
    scheduleId: 'sub_sched_1',
    current: CURRENT,
    deltasByTier: new Map([[S3, -1]]),
    priceByTier: PRICES,
    idempotencyKey: 'intent-2',
  })
  assertEquals(calls, ['GET /v1/subscription_schedules/sub_sched_1', 'POST /v1/subscription_schedules/sub_sched_1'])
  calls.length = 0
  const released = await syncDeferredSchedule(client, {
    providerSubscriptionId: 'sub_1',
    scheduleId: 'sub_sched_1',
    current: CURRENT,
    deltasByTier: new Map(),
    priceByTier: PRICES,
    idempotencyKey: 'intent-3',
  })
  assertEquals(released.scheduleId, null)
  assertEquals(calls, ['POST /v1/subscription_schedules/sub_sched_1/release'])
})

test('an immediate mutation releases the schedule first, applies, then rebuilds from the ledger', async () => {
  const calls: string[] = []
  const client = createStripeClientDouble(scheduleResponder(calls))
  const result = await mutateSubscription(client, {
    kind: 'immediate',
    providerSubscriptionId: 'sub_1',
    scheduleId: 'sub_sched_1',
    items: [{ id: 'si_3', quantity: 3 }, { id: 'si_5', quantity: 1 }],
    prorationDate: 1_758_000_000,
    idempotencyKey: 'upgrade-1',
    deferredDeltasByTier: new Map([[S5, -1], [S3, 1]]),
    priceByTier: PRICES,
    tierByPrice: new Map([['price_s3', S3], ['price_s5', S5]]),
  })
  assertEquals(result.applied?.pending, false)
  assertEquals(result.scheduleId, 'sub_sched_1')
  assertEquals(calls, [
    'POST /v1/subscription_schedules/sub_sched_1/release',
    'POST /v1/subscriptions/sub_1',
    'GET /v1/subscriptions/sub_1',
    'POST /v1/subscription_schedules',
    'POST /v1/subscription_schedules/sub_sched_1',
  ])
  const [release, apply, , , rebuilt] = client.calls
  assertEquals(release!.idempotencyKey, 'upgrade-1:release')
  assertEquals(apply!.idempotencyKey, 'upgrade-1')
  assertEquals(formOf(apply!, 'proration_date'), '1758000000')
  // The rebuilt future phase starts from the refetched (post-upgrade) items: S3 3 → 4, S5 1 → 0.
  assertEquals(formOf(rebuilt!, 'phases[1][items][0][price]'), 'price_s3')
  assertEquals(formOf(rebuilt!, 'phases[1][items][0][quantity]'), '4')
  assertEquals(formKeys(rebuilt!).includes('phases[1][items][1][price]'), false)
})

test('an immediate mutation parked as pending leaves the schedule to the projection', async () => {
  const calls: string[] = []
  const client = createStripeClientDouble((call) => {
    calls.push(`${call.method} ${call.path}`)
    return { id: 'sub_1', status: 'active', pending_update: { expires_at: 1 } }
  })
  const result = await mutateSubscription(client, {
    kind: 'immediate',
    providerSubscriptionId: 'sub_1',
    scheduleId: null,
    items: [{ id: 'si_3', quantity: 3 }],
    prorationDate: 1,
    idempotencyKey: 'upgrade-2',
    deferredDeltasByTier: new Map([[S5, -1]]),
    priceByTier: PRICES,
    tierByPrice: new Map(),
  })
  assertEquals(result.applied?.pending, true)
  assertEquals(result.scheduleId, null)
  assertEquals(calls, ['POST /v1/subscriptions/sub_1'])
})
