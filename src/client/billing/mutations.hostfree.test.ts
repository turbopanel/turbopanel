/**
 * Host-free coverage for the mutation bodies.
 *
 * Part one: an immediate seat increase is retry-safe — the idempotency key
 * Stripe saw is persisted before the call and replayed by the retry, so a
 * failure after Stripe accepted the update but before the reprojection
 * landed cannot buy the seats a second time. The projection runs for real
 * against the in-memory db; only the Stripe client is a double, and the
 * injected failure is its refetch (`get`) rejecting — the one call that
 * sits between "Stripe applied it" and "Postgres knows".
 *
 * Part two (ledger T1–T3): the tier moves and the seat decrease, against
 * the recording client double so the exact form Stripe receives is pinned
 * — an upgrade parked under `pending_update` leaves entitlement alone; a
 * downgrade and a seat decrease write only the ledger and a schedule
 * phase, never a seat or license row; and a Stripe failure on either rolls
 * the fresh intents back.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { StripeClient } from '../../lib/billing/client.ts'
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from '../../lib/billing/customer-subject.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import {
  emptyLedger,
  newDeferredIntent,
  readPendingChanges,
  withIntent,
  writePendingChanges,
} from '../../lib/billing/pending-changes.ts'
import { billingSeatIncreaseKey, parseSeatIncreaseRecord } from '../../lib/billing/seat-increase.ts'
import { license, payer, setting, subscription, subscriptionItem, tier } from '../../lib/db/schema.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import { createStripeClientDouble, formOf, type StripeCall } from '../../test-fixtures/stripe-client.ts'
import { type BillingMutationOutcome, changeSeats, downgradeLicense, upgradeLicense } from './mutations.ts'
import {
  LICENSE_HAS_PENDING_CHANGE_ERROR,
  loadBillingOrgView,
  NOT_AN_UPGRADE_ERROR,
  SEATS_IN_USE_ERROR,
  SUBSCRIPTION_PAST_DUE_ERROR,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S3 = '33333333-3333-4333-8333-333333333331'
const NOW = '2026-09-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

const TIER_S3 = {
  id: S3, label: 'S3', generation: 1, rank: 3, priceCents: 1000, providerPriceId: 'price_S3', isCustom: false, isActive: true,
  successorId: null, maxCores: 16, maxMemoryBytes: 1, nicSlots: 5, driveSlots: 6, gpuSlots: 2, filesystemSlots: 9, createdAt: NOW, updatedAt: NOW,
}

/** One projected organization: an active subscription with two S3 seats. */
function projectedDb(): MemoryDb {
  return createMemoryDb([
    [setting, []],
    [payer, [{ id: 'payer-1', provider: 'stripe', providerCustomerId: 'cus_1', organizationId: ORG, userId: null, taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{ id: 'sub-row', payerId: 'payer-1', providerSubscriptionId: 'sub_1', status: 'active', currentPeriodEnd: null, scheduleId: null, pastDueSince: null, graceExpiresAt: null, createdAt: NOW, updatedAt: NOW }]],
    [subscriptionItem, [{ id: 'seat-1', subscriptionId: 'sub-row', tierId: S3, providerItemId: 'si_1', quantity: 2, createdAt: NOW, updatedAt: NOW }]],
    [tier, [TIER_S3]],
    [license, []],
  ])
}

type Post = { path: string; idempotencyKey: string | undefined; body: Record<string, unknown> | undefined }

/** What Stripe hands back once the increase is committed: three S3 seats. */
function subscriptionFromStripe(quantity: number) {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    schedule: null,
    customer: {
      id: 'cus_1',
      object: 'customer',
      metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG },
      tax_ids: { object: 'list', data: [], has_more: false },
    },
    items: {
      object: 'list',
      has_more: false,
      data: [{ id: 'si_1', object: 'subscription_item', quantity, price: { id: 'price_S3' } }],
    },
  }
}

/**
 * A Stripe double whose `post` records every idempotency key and whose
 * refetch (`get`) fails the first `failRefetches` times — the injected gap
 * between Stripe accepting the update and the reprojection completing.
 */
function stripeDouble(opts: { failRefetches?: number; postError?: () => Error } = {}) {
  const posts: Post[] = []
  let refetches = 0
  let committedQuantity = 2
  const client: StripeClient = {
    get: (path) => {
      if (!path.startsWith('/v1/subscriptions/sub_1')) return Promise.reject(new Error(`unexpected get ${path}`))
      refetches += 1
      if (refetches <= (opts.failRefetches ?? 0)) return Promise.reject(new Error('injected: refetch failed'))
      return Promise.resolve(subscriptionFromStripe(committedQuantity) as never)
    },
    post: (path, body, mutation) => {
      posts.push({ path, idempotencyKey: mutation?.idempotencyKey, body })
      if (opts.postError) return Promise.reject(opts.postError())
      // Stripe applied the update: the next refetch shows the raised quantity.
      committedQuantity = 3
      return Promise.resolve({ id: 'sub_1', object: 'subscription', status: 'active' } as never)
    },
    del: (path) => Promise.reject(new Error(`unexpected del ${path}`)),
    listAll: (path) => Promise.reject(new Error(`unexpected listAll ${path}`)),
  }
  return { client, posts }
}

function depsFor(db: MemoryDb, client: StripeClient) {
  const leases: string[] = []
  return {
    leases,
    deps: {
      db,
      client,
      loadView: loadBillingOrgView,
      beginMutation: () => {
        leases.push('begin')
        return Promise.resolve({ organizationId: ORG, owner: 'test' })
      },
      endMutation: () => {
        leases.push('end')
        return Promise.resolve()
      },
      nowMs: () => NOW_MS,
    },
  }
}

function storedRecord(db: MemoryDb) {
  const row = db.rows(setting).find((r) => r.key === billingSeatIncreaseKey(ORG))
  return row ? parseSeatIncreaseRecord(row.value) : null
}

test('a seat increase whose reprojection fails after Stripe accepted it is retried under the SAME idempotency key, then the record is cleared', async () => {
  const db = projectedDb()
  const { client, posts } = stripeDouble({ failRefetches: 1 })
  const { deps, leases } = depsFor(db, client)
  const input = { organizationId: ORG, tierId: S3, delta: 1, prorationDate: 1_800_000_000 }

  // Attempt 1: Stripe accepts the update; the reprojection's refetch fails.
  await assertRejects(() => changeSeats(deps, input), Error, 'injected: refetch failed')
  assertEquals(posts.length, 1)
  assertEquals(posts[0]?.path, '/v1/subscriptions/sub_1')
  const firstKey = posts[0]?.idempotencyKey
  assertEquals(typeof firstKey, 'string')
  // The record survived the failure, carrying the key and the proration date Stripe saw.
  const record = storedRecord(db)
  assertEquals(record?.idempotencyKey, firstKey)
  assertEquals(record?.prorationDate, 1_800_000_000)
  assertEquals(record?.tierId, S3)
  assertEquals(record?.delta, 1)
  // Postgres still says two seats: entitlement did not move on a failed projection.
  assertEquals(db.rows(subscriptionItem).map((r) => r.quantity), [2])
  assertEquals(leases, ['begin', 'end'])

  // Attempt 2 — the console's retry, same request, no proration date this time.
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 })
  assertEquals(outcome.ok, true)
  assertEquals(posts.length, 2)
  // Same key and the same pinned proration date: Stripe replays, it does not re-apply.
  assertEquals(posts[1]?.idempotencyKey, firstKey)
  assertEquals(posts[1]?.body?.proration_date, 1_800_000_000)
  assertEquals(posts[0]?.body, posts[1]?.body)
  // The reprojection landed the committed quantity and consumed the record.
  assertEquals(db.rows(subscriptionItem).map((r) => r.quantity), [3])
  assertEquals(storedRecord(db), null)
  assertEquals(leases, ['begin', 'end', 'begin', 'end'])
})

test('a permanent Stripe refusal clears the record, so the next attempt is a fresh request with a new key', async () => {
  const db = projectedDb()
  const { client, posts } = stripeDouble({
    postError: () => new StripeApiError({ status: 400, type: 'invalid_request_error', message: 'no such price' }),
  })
  const { deps } = depsFor(db, client)
  const input = { organizationId: ORG, tierId: S3, delta: 1 }
  await assertRejects(() => changeSeats(deps, input), StripeApiError)
  assertEquals(storedRecord(db), null)
  await assertRejects(() => changeSeats(deps, input), StripeApiError)
  assertEquals(posts.length, 2)
  assertEquals(posts[0]?.idempotencyKey === posts[1]?.idempotencyKey, false)
})

test('a transient Stripe failure keeps the record: the retry presents the same key', async () => {
  const db = projectedDb()
  let calls = 0
  const { client, posts } = stripeDouble({
    postError: () => {
      calls += 1
      return new StripeApiError({ status: 503, type: 'api_error', message: 'try again' })
    },
  })
  const { deps } = depsFor(db, client)
  const input = { organizationId: ORG, tierId: S3, delta: 2 }
  await assertRejects(() => changeSeats(deps, input), StripeApiError)
  assertEquals(calls, 1)
  const record = storedRecord(db)
  assertEquals(record?.idempotencyKey, posts[0]?.idempotencyKey)
  await assertRejects(() => changeSeats(deps, input), StripeApiError)
  assertEquals(posts.length, 2)
  assertEquals(posts[1]?.idempotencyKey, posts[0]?.idempotencyKey)
})

test('a different request after a transient failure is not a retry: it gets its own key and replaces the record', async () => {
  const db = projectedDb()
  const { client, posts } = stripeDouble({ failRefetches: 1 })
  const { deps } = depsFor(db, client)
  await assertRejects(() => changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 }), Error, 'injected: refetch failed')
  const first = storedRecord(db)
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 2 })
  assertEquals(outcome.ok, true)
  assertEquals(posts.length, 2)
  assertEquals(posts[1]?.idempotencyKey === first?.idempotencyKey, false)
  assertEquals(storedRecord(db), null)
})

test('a seat increase succeeding first time leaves no record behind', async () => {
  const db = projectedDb()
  const { client, posts } = stripeDouble()
  const { deps } = depsFor(db, client)
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body, { ok: true, pending: false, deferred: false })
  assertEquals(posts.length, 1)
  assertEquals(storedRecord(db), null)
  assertEquals(db.rows(subscriptionItem).map((r) => r.quantity), [3])
})

test('a retry replays the stored items even after a webhook moved the seat rows meanwhile — never items rebuilt from the new rows', async () => {
  const db = projectedDb()
  const { client, posts } = stripeDouble({ failRefetches: 1 })
  const { deps } = depsFor(db, client)
  const input = { organizationId: ORG, tierId: S3, delta: 1 }
  await assertRejects(() => changeSeats(deps, input), Error, 'injected: refetch failed')
  assertEquals(posts[0]?.body?.items, [{ id: 'si_1', quantity: 3 }])

  // Between the failed reprojection and the console's retry, the webhook for
  // the very update attempt 1 made lands and projects three seats.
  for (const row of db.rows(subscriptionItem)) row.quantity = 3

  const outcome = await changeSeats(deps, input)
  assertEquals(outcome.ok, true)
  assertEquals(posts.length, 2)
  // Rebuilding from the rows would have sent quantity 4 under the old key —
  // an idempotency_error, then a fresh key and a real fourth seat.
  assertEquals(posts[1]?.body, posts[0]?.body)
  assertEquals(posts[1]?.idempotencyKey, posts[0]?.idempotencyKey)
  assertEquals(storedRecord(db), null)
  assertEquals(db.rows(subscriptionItem).map((r) => r.quantity), [3])
})

// ---------------------------------------------------------------------------
// T1–T3: tier moves and the seat decrease, on the recording client double.
// ---------------------------------------------------------------------------

const S1 = '33333333-3333-4333-8333-333333333311'
const S5 = '33333333-3333-4333-8333-333333333335'
const L1 = '44444444-4444-4444-8444-444444444441'
const L2 = '44444444-4444-4444-8444-444444444442'

const TIER_S1 = { ...TIER_S3, id: S1, label: 'S1', rank: 1, priceCents: 500, providerPriceId: 'price_S1', maxCores: 4 }
const TIER_S5 = { ...TIER_S3, id: S5, label: 'S5', rank: 5, priceCents: 3000, providerPriceId: 'price_S5', maxCores: 32 }

type SeatSeed = { id: string; tierId: string; providerItemId: string; quantity: number }
type LicenseSeed = { id: string; tierId: string }

/** One projected organization with the given seats and licenses; S1, S3 and S5 in the catalogue. */
function orgDb(opts: { seats: SeatSeed[]; licenses: LicenseSeed[]; status?: string }): MemoryDb {
  return createMemoryDb([
    [setting, []],
    [payer, [{ id: 'payer-1', provider: 'stripe', providerCustomerId: 'cus_1', organizationId: ORG, userId: null, taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{
      id: 'sub-row', payerId: 'payer-1', providerSubscriptionId: 'sub_1', status: opts.status ?? 'active',
      currentPeriodEnd: null, scheduleId: null, pastDueSince: null, graceExpiresAt: null, createdAt: NOW, updatedAt: NOW,
    }]],
    [subscriptionItem, opts.seats.map((seat) => ({ ...seat, subscriptionId: 'sub-row', createdAt: NOW, updatedAt: NOW }))],
    [tier, [TIER_S1, TIER_S3, TIER_S5]],
    [license, opts.licenses.map((row) => ({
      id: row.id, organizationId: ORG, serverId: null, tierId: row.tierId, name: null, token: `tok-${row.id}`,
      revokedAt: null, createdAt: NOW, updatedAt: NOW,
    }))],
  ])
}

type StripeItem = { id: string; price: string; quantity: number }

/** The subscription as the projection refetches it (customer expanded, tax ids listed). */
function stripeSubscription(items: StripeItem[], opts: { pendingUpdate?: boolean } = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    schedule: null,
    ...(opts.pendingUpdate ? { pending_update: { expires_at: NOW_MS / 1000 + 3600 } } : {}),
    customer: {
      id: 'cus_1',
      object: 'customer',
      metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG },
      tax_ids: { object: 'list', data: [], has_more: false },
    },
    items: {
      object: 'list',
      has_more: false,
      data: items.map((item) => ({ id: item.id, object: 'subscription_item', quantity: item.quantity, price: { id: item.price } })),
    },
  }
}

const PERIOD_START = 1_700_000_000
const PERIOD_END = 1_702_592_000

/** A schedule as Stripe returns it: one current phase covering the period. */
function stripeSchedule(currentItems: { price: string; quantity: number }[]) {
  return {
    id: 'sub_sched_1',
    object: 'subscription_schedule',
    status: 'active',
    subscription: 'sub_1',
    phases: [{ start_date: PERIOD_START, end_date: PERIOD_END, items: currentItems }],
  }
}

type Route = `${StripeCall['method']} ${string}`

/** A client double answering by `METHOD path`; anything else is a test bug. */
function routedClient(routes: Partial<Record<Route, (call: StripeCall) => unknown>>) {
  return createStripeClientDouble((call) => {
    const handler = routes[`${call.method} ${call.path}` as Route]
    if (!handler) throw new Error(`unexpected Stripe call ${call.method} ${call.path}`)
    return handler(call)
  })
}

async function ledgerOf(db: MemoryDb) {
  return (await readPendingChanges(db, ORG, 'sub_1', NOW_MS)).ledger
}

function seatQuantities(db: MemoryDb): Record<string, number> {
  return Object.fromEntries(db.rows(subscriptionItem).map((row) => [row.tierId, row.quantity]))
}

function licenseTier(db: MemoryDb, id: string): string | null {
  return (db.rows(license).find((row) => row.id === id)?.tierId as string | undefined) ?? null
}

/** Narrow a mutation outcome to its refusal body, failing loudly on a success. */
function refusalOf<T extends Record<string, unknown>>(outcome: BillingMutationOutcome<T>) {
  if (outcome.ok) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.body)}`)
  return { status: outcome.status, body: outcome.body }
}

/** Every `phases[n][items][m][<field>]` key of a schedule write. */
function phaseItemFields(call: StripeCall): string[] {
  return call.form
    .map(([key]) => /^phases\[\d+\]\[items\]\[\d+\]\[(.+)\]$/.exec(key)?.[1])
    .filter((field): field is string => field !== undefined)
}

// --- T1 -------------------------------------------------------------------

test('T1 · an upgrade Stripe parks under pending_update records the intent and leaves the license where it was', async () => {
  const db = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 2 }], licenses: [{ id: L1, tierId: S3 }, { id: L2, tierId: S3 }] })
  const client = routedClient({
    'POST /v1/subscriptions/sub_1': () => ({ id: 'sub_1', object: 'subscription', status: 'active', pending_update: { expires_at: 1 } }),
    'GET /v1/subscriptions/sub_1': () => stripeSubscription([{ id: 'si_1', price: 'price_S3', quantity: 2 }], { pendingUpdate: true }),
  })
  const { deps, leases } = depsFor(db, client)

  const outcome = await upgradeLicense(deps, { organizationId: ORG, licenseId: L1, targetTierId: S5, prorationDate: 1_800_000_000 })
  assertEquals(outcome.ok, true)
  if (!outcome.ok) return
  assertEquals(outcome.body.pending, true)

  // One upgrade intent, naming the license and both tiers; the body echoes its id.
  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 1)
  const intent = ledger.intents[0]!
  assertEquals(intent.kind, 'upgrade')
  assertEquals(intent.licenseId, L1)
  assertEquals(intent.fromTierId, S3)
  assertEquals(intent.toTierId, S5)
  assertEquals(outcome.body.intentId, intent.id)

  // Entitlement did not move: Stripe has not charged for it yet.
  assertEquals(licenseTier(db, L1), S3)
  assertEquals(seatQuantities(db), { [S3]: 2 })

  // Exactly one write, then the reprojection's refetch.
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['POST /v1/subscriptions/sub_1', 'GET /v1/subscriptions/sub_1'])
  const post = client.calls[0]!
  assertEquals(post.idempotencyKey, intent.idempotencyKey)
  assertEquals(formOf(post, 'payment_behavior'), 'pending_if_incomplete')
  assertEquals(formOf(post, 'proration_behavior'), 'always_invoice')
  assertEquals(formOf(post, 'proration_date'), '1800000000')
  // The source item carries its id AND its new quantity (never id alone),
  // the target is a new item by price.
  assertEquals(formOf(post, 'items[0][id]'), 'si_1')
  assertEquals(formOf(post, 'items[0][quantity]'), '1')
  assertEquals(formOf(post, 'items[1][price]'), 'price_S5')
  assertEquals(formOf(post, 'items[1][quantity]'), '1')
  assertEquals(formOf(post, 'items[0][price]'), undefined)
  assertEquals(leases, ['begin', 'end'])
})

test('T1 · guard: the same upgrade landing (no pending_update) repoints the license and consumes the intent', async () => {
  const db = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 2 }], licenses: [{ id: L1, tierId: S3 }, { id: L2, tierId: S3 }] })
  const client = routedClient({
    'POST /v1/subscriptions/sub_1': () => ({ id: 'sub_1', object: 'subscription', status: 'active' }),
    'GET /v1/subscriptions/sub_1': () => stripeSubscription([
      { id: 'si_1', price: 'price_S3', quantity: 1 },
      { id: 'si_2', price: 'price_S5', quantity: 1 },
    ]),
  })
  const { deps } = depsFor(db, client)

  const outcome = await upgradeLicense(deps, { organizationId: ORG, licenseId: L1, targetTierId: S5 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body.pending, false)
  // The committed items show the swap, so the sync moved the named license
  // and the intent is gone — the webhook that follows is redundant.
  assertEquals(licenseTier(db, L1), S5)
  assertEquals(licenseTier(db, L2), S3)
  assertEquals(seatQuantities(db), { [S3]: 1, [S5]: 1 })
  assertEquals((await ledgerOf(db)).intents, [])
})

test('T1 · refusals happen before any Stripe call: past due, wrong direction, and a license with another pending change', async () => {
  // Past due: the C8 gate, with the grace deadline in the body.
  const pastDue = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 2 }], licenses: [{ id: L1, tierId: S3 }], status: 'past_due' })
  const client = routedClient({})
  const denied = refusalOf(await upgradeLicense(depsFor(pastDue, client).deps, { organizationId: ORG, licenseId: L1, targetTierId: S5 }))
  assertEquals(denied.status, 409)
  assertEquals(denied.body.error, SUBSCRIPTION_PAST_DUE_ERROR)
  assertEquals((await ledgerOf(pastDue)).intents, [])

  // Not an upgrade: S5 → S3 through the upgrade route.
  const down = orgDb({ seats: [{ id: 'seat-5', tierId: S5, providerItemId: 'si_5', quantity: 1 }], licenses: [{ id: L1, tierId: S5 }] })
  const wrongWay = refusalOf(await upgradeLicense(depsFor(down, client).deps, { organizationId: ORG, licenseId: L1, targetTierId: S3 }))
  assertEquals(wrongWay.status, 400)
  assertEquals(wrongWay.body.error, NOT_AN_UPGRADE_ERROR)

  // A downgrade already parked on the license: the upgrade is refused, naming it.
  const busy = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 2 }], licenses: [{ id: L1, tierId: S3 }] })
  const parked = newDeferredIntent('downgrade', { licenseId: L1, fromTierId: S3, toTierId: S1, nowMs: NOW_MS })
  await writePendingChanges(busy, ORG, withIntent(emptyLedger('sub_1'), parked), NOW_MS)
  const conflict = refusalOf(await upgradeLicense(depsFor(busy, client).deps, { organizationId: ORG, licenseId: L1, targetTierId: S5 }))
  assertEquals(conflict.status, 409)
  assertEquals(conflict.body.error, LICENSE_HAS_PENDING_CHANGE_ERROR)
  assertEquals((conflict.body.intent as { id: string }).id, parked.id)

  assertEquals(client.calls, [])
})

// --- T2 -------------------------------------------------------------------

test('T2 · a downgrade writes the intent and a schedule phase for the boundary; seats and the license stay put', async () => {
  // The target tier has no seat line yet, so the future phase must mint a new item by price.
  const db = orgDb({ seats: [{ id: 'seat-5', tierId: S5, providerItemId: 'si_5', quantity: 1 }], licenses: [{ id: L1, tierId: S5 }] })
  const client = routedClient({
    'POST /v1/subscription_schedules': () => stripeSchedule([{ price: 'price_S5', quantity: 1 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_S5', quantity: 1 }]),
  })
  const { deps, leases } = depsFor(db, client)

  const outcome = await downgradeLicense(deps, { organizationId: ORG, licenseId: L1, targetTierId: S3 })
  assertEquals(outcome.ok, true)
  if (!outcome.ok) return
  assertEquals(outcome.body.deferred, true)
  assertEquals(outcome.body.scheduleId, 'sub_sched_1')

  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 1)
  const intent = ledger.intents[0]!
  assertEquals(intent.kind, 'downgrade')
  assertEquals(intent.licenseId, L1)
  assertEquals(intent.fromTierId, S5)
  assertEquals(intent.toTierId, S3)
  assertEquals(outcome.body.intentId, intent.id)

  // Nothing moved now: the boundary does that.
  assertEquals(licenseTier(db, L1), S5)
  assertEquals(seatQuantities(db), { [S5]: 1 })

  // Ensure a schedule from the subscription, then rewrite every phase.
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['POST /v1/subscription_schedules', 'POST /v1/subscription_schedules/sub_sched_1'])
  const [create, phases] = client.calls as [StripeCall, StripeCall]
  assertEquals(formOf(create, 'from_subscription'), 'sub_1')
  assertEquals(create.idempotencyKey, `${intent.idempotencyKey}:schedule`)
  assertEquals(phases.idempotencyKey, `${intent.idempotencyKey}:phases`)
  assertEquals(formOf(phases, 'end_behavior'), 'release')
  // The current phase restated with its own dates and items…
  assertEquals(formOf(phases, 'phases[0][start_date]'), String(PERIOD_START))
  assertEquals(formOf(phases, 'phases[0][end_date]'), String(PERIOD_END))
  assertEquals(formOf(phases, 'phases[0][items][0][price]'), 'price_S5')
  assertEquals(formOf(phases, 'phases[0][items][0][quantity]'), '1')
  // …then one contiguous future phase, one month long, holding only the target.
  assertEquals(formOf(phases, 'phases[1][start_date]'), String(PERIOD_END))
  assertEquals(formOf(phases, 'phases[1][duration][interval]'), 'month')
  assertEquals(formOf(phases, 'phases[1][duration][interval_count]'), '1')
  assertEquals(formOf(phases, 'phases[1][items][0][price]'), 'price_S3')
  assertEquals(formOf(phases, 'phases[1][items][0][quantity]'), '1')
  assertEquals(formOf(phases, 'phases[1][items][1][price]'), undefined)
  // Phase items carry price and quantity only — never an item id.
  assertEquals(new Set(phaseItemFields(phases)), new Set(['price', 'quantity']))
  assertEquals(leases, ['begin', 'end'])
})

test('T2 · a Stripe failure rolls a fresh downgrade intent back; a retry of the same downgrade reuses the intent and its key', async () => {
  const db = orgDb({ seats: [{ id: 'seat-5', tierId: S5, providerItemId: 'si_5', quantity: 1 }], licenses: [{ id: L1, tierId: S5 }] })
  let fail = true
  const client = routedClient({
    'POST /v1/subscription_schedules': () => {
      if (fail) throw new StripeApiError({ status: 503, type: 'api_error', message: 'try again' })
      return stripeSchedule([{ price: 'price_S5', quantity: 1 }])
    },
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_S5', quantity: 1 }]),
  })
  const { deps, leases } = depsFor(db, client)
  const input = { organizationId: ORG, licenseId: L1, targetTierId: S3 }

  await assertRejects(() => downgradeLicense(deps, input), StripeApiError)
  // Nothing is parked on the provider, so nothing stays in the ledger.
  assertEquals((await ledgerOf(db)).intents, [])
  assertEquals(licenseTier(db, L1), S5)
  assertEquals(seatQuantities(db), { [S5]: 1 })
  assertEquals(leases, ['begin', 'end'])

  fail = false
  const first = await downgradeLicense(deps, input)
  assertEquals(first.ok, true)
  const again = await downgradeLicense(deps, input)
  assertEquals(again.ok, true)
  assertEquals(again.ok && first.ok && again.body.intentId, first.ok && first.body.intentId)
  assertEquals((await ledgerOf(db)).intents.length, 1)
  // The key reuse is the pin. The retry re-creates from the subscription only
  // because nothing here projects `schedule_id` back onto the row; once the
  // webhook has, `ensureSchedule` GETs the existing schedule instead, and the
  // count below is the thing to relax — not the key equality.
  const creates = client.calls.filter((c) => c.path === '/v1/subscription_schedules')
  assertEquals(creates.length, 3)
  assertEquals(creates[1]!.idempotencyKey, creates[2]!.idempotencyKey)
})

// --- T3 -------------------------------------------------------------------

test('T3 · a seat decrease is one release-seat intent per seat plus a schedule phase at the reduced quantity; seats are untouched', async () => {
  const db = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 3 }], licenses: [{ id: L1, tierId: S3 }, { id: L2, tierId: S3 }] })
  const client = routedClient({
    'POST /v1/subscription_schedules': () => stripeSchedule([{ price: 'price_S3', quantity: 3 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_S3', quantity: 3 }]),
  })
  const { deps, leases } = depsFor(db, client)

  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: -1 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body, { ok: true, pending: false, deferred: true, scheduleId: 'sub_sched_1' })

  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 1)
  const intent = ledger.intents[0]!
  assertEquals(intent.kind, 'release-seat')
  assertEquals(intent.licenseId, null)
  assertEquals(intent.fromTierId, S3)
  assertEquals(intent.toTierId, null)

  assertEquals(seatQuantities(db), { [S3]: 3 })
  const [create, phases] = client.calls as [StripeCall, StripeCall]
  assertEquals(create.idempotencyKey, `${intent.idempotencyKey}:schedule`)
  assertEquals(formOf(phases, 'phases[1][items][0][price]'), 'price_S3')
  assertEquals(formOf(phases, 'phases[1][items][0][quantity]'), '2')
  assertEquals(formOf(phases, 'phases[1][items][1][price]'), undefined)
  assertEquals(leases, ['begin', 'end'])
})

test('T3 · a decrease below the licenses still counting at the tier is refused with the free count, before any Stripe call', async () => {
  const db = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 3 }], licenses: [{ id: L1, tierId: S3 }, { id: L2, tierId: S3 }] })
  const client = routedClient({})
  const outcome = refusalOf(await changeSeats(depsFor(db, client).deps, { organizationId: ORG, tierId: S3, delta: -2 }))
  assertEquals(outcome.status, 409)
  assertEquals(outcome.body, { error: SEATS_IN_USE_ERROR, tierId: S3, licensesFree: 1 })
  assertEquals(client.calls, [])
  assertEquals((await ledgerOf(db)).intents, [])
})

test('T3 · a Stripe rejection of the decrease rolls back exactly the intents it added and rethrows', async () => {
  const db = orgDb({ seats: [{ id: 'seat-3', tierId: S3, providerItemId: 'si_1', quantity: 4 }], licenses: [{ id: L1, tierId: S3 }, { id: L2, tierId: S3 }] })
  // An unrelated intent already in the ledger must survive the rollback.
  const parked = newDeferredIntent('downgrade', { licenseId: L2, fromTierId: S3, toTierId: S1, nowMs: NOW_MS })
  await writePendingChanges(db, ORG, withIntent(emptyLedger('sub_1'), parked), NOW_MS)
  const client = routedClient({
    'POST /v1/subscription_schedules': () => {
      throw new StripeApiError({ status: 400, type: 'invalid_request_error', message: 'no' })
    },
  })
  const { deps, leases } = depsFor(db, client)

  await assertRejects(() => changeSeats(deps, { organizationId: ORG, tierId: S3, delta: -2 }), StripeApiError)
  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.map((i) => i.id), [parked.id])
  assertEquals(seatQuantities(db), { [S3]: 4 })
  assertEquals(client.calls.length, 1)
  assertEquals(leases, ['begin', 'end'])
})
