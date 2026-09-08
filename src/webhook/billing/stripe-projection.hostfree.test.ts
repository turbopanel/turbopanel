/**
 * Host-free coverage for the projection itself (ledger T6, T7): the
 * refetch-then-project seam driven directly, with the recording client
 * double answering by route and the in-memory db holding the three rows.
 *
 * T6 — every "log and skip" branch skips *before* a row is written, and a
 * refetch that rejects writes nothing. T7 — the response shapes the pinned
 * API version (`2025-08-27.basil`) sends and the older shapes still in the
 * wild both project the same rows: period end on the subscription or per
 * item, the invoice's subscription pre- and post-basil, a Checkout session
 * naming its subscription as an id or an object, the second page of items,
 * an unexpanded price.
 */

import { assertEquals, assertRejects } from '@std/assert'
import {
  STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY,
  STRIPE_CUSTOMER_USER_METADATA_KEY,
} from '../../lib/billing/customer-subject.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import { license, payer, setting, subscription, subscriptionItem, tier } from '../../lib/db/schema.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import { createStripeClientDouble, formOf, type StripeCall } from '../../test-fixtures/stripe-client.ts'
import { projectStripeEvent, projectSubscriptionById, type StripeProjectionOutcome } from './stripe-projection.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const USER = '7ba7b810-9dad-11d1-80b4-00c04fd430c9'
const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-09-07T12:00:00.000Z'

const tierRow = (id: string, label: string, rank: number) => ({
  id, label, generation: 1, rank, priceCents: 1000 * rank, providerPriceId: `price_${label}`, isCustom: false, isActive: true,
  successorId: null, maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1, createdAt: NOW, updatedAt: NOW,
})

/** An empty projection target: the catalogue and nothing projected yet. */
function emptyDb(): MemoryDb {
  return createMemoryDb([
    [setting, []],
    [payer, []],
    [subscription, []],
    [subscriptionItem, []],
    [tier, [tierRow(S1, 'S1', 1), tierRow(S2, 'S2', 2)]],
    [license, []],
  ])
}

type Obj = Record<string, unknown>

/** The subscription as the refetch returns it, with the parts under test overridable. */
function stripeSubscription(overrides: Obj = {}, customerOverrides: Obj = {}): Obj {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    schedule: null,
    customer: {
      id: 'cus_1',
      object: 'customer',
      metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG },
      tax_ids: { object: 'list', data: [{ value: 'DE123456789' }], has_more: false },
      ...customerOverrides,
    },
    items: {
      object: 'list',
      has_more: false,
      data: [{ id: 'si_1', object: 'subscription_item', quantity: 2, price: { id: 'price_S1' } }],
    },
    ...overrides,
  }
}

type Route = `${StripeCall['method']} ${string}`

function routedClient(routes: Partial<Record<Route, (call: StripeCall) => unknown>>) {
  return createStripeClientDouble((call) => {
    const handler = routes[`${call.method} ${call.path}` as Route]
    if (!handler) throw new Error(`unexpected Stripe call ${call.method} ${call.path}`)
    return handler(call)
  })
}

const SUB_ROUTE: Route = 'GET /v1/subscriptions/sub_1'

function rowCounts(db: MemoryDb) {
  return { payer: db.rows(payer).length, subscription: db.rows(subscription).length, seat: db.rows(subscriptionItem).length }
}

function skipped(outcome: StripeProjectionOutcome): string {
  if (outcome.action !== 'skipped') throw new Error(`expected a skip, got ${JSON.stringify(outcome)}`)
  return outcome.reason
}

function projected(outcome: StripeProjectionOutcome) {
  if (outcome.action !== 'projected') throw new Error(`expected a projection, got ${JSON.stringify(outcome)}`)
  return outcome
}

// --- T6 -------------------------------------------------------------------

test('T6 · every customer/subject/status skip answers its reason and writes no row', async () => {
  const cases: [string, Obj, Obj][] = [
    ['customer_deleted', {}, { deleted: true }],
    ['customer_missing', {}, { id: undefined }],
    ['customer_subject_missing', {}, { metadata: {} }],
    ['customer_subject_missing', {}, { metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG, [STRIPE_CUSTOMER_USER_METADATA_KEY]: USER } }],
    ['customer_subject_missing', {}, { metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: 'not-a-uuid' } }],
    ['customer_subject_missing', {}, { metadata: 'nonsense' }],
    ['status_missing', { status: '' }, {}],
  ]
  for (const [reason, subOverrides, customerOverrides] of cases) {
    const db = emptyDb()
    const client = routedClient({ [SUB_ROUTE]: () => stripeSubscription(subOverrides, customerOverrides) })
    const outcome = await projectSubscriptionById({ db, client, now: NOW }, 'sub_1')
    assertEquals(skipped(outcome), reason)
    assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 }, reason)
    assertEquals(client.calls.length, 1, reason)
  }
})

test('T6 · a subject id is accepted case-insensitively and stored lowercased', async () => {
  const db = emptyDb()
  const client = routedClient({
    [SUB_ROUTE]: () => stripeSubscription({}, { metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG.toUpperCase() } }),
  })
  projected(await projectSubscriptionById({ db, client, now: NOW }, 'sub_1'))
  assertEquals(db.rows(payer)[0]?.organizationId, ORG)
})

test('T6 · a customer naming a user projects the rows but syncs no entitlements', async () => {
  const db = emptyDb()
  const client = routedClient({
    [SUB_ROUTE]: () => stripeSubscription({}, { metadata: { [STRIPE_CUSTOMER_USER_METADATA_KEY]: USER } }),
  })
  const outcome = projected(await projectSubscriptionById({ db, client, now: NOW }, 'sub_1'))
  assertEquals(outcome.entitlements, null)
  assertEquals(outcome.skippedItems, [])
  const [payerRow] = db.rows(payer)
  assertEquals(payerRow?.userId, USER)
  assertEquals(payerRow?.organizationId, null)
  assertEquals(rowCounts(db), { payer: 1, subscription: 1, seat: 1 })
  // No lease, no ledger: the entitlement sync never ran.
  assertEquals(db.rows(setting), [])
})

test('T6 · a refetch that fails writes nothing — the rows are only ever written from a successful read', async () => {
  const db = emptyDb()
  const client = routedClient({
    [SUB_ROUTE]: () => {
      throw new StripeApiError({ status: 404, type: 'invalid_request_error', message: 'No such subscription' })
    },
  })
  await assertRejects(() => projectSubscriptionById({ db, client, now: NOW }, 'sub_1'), StripeApiError)
  assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 })
})

test('T6 · projectStripeEvent skips a ref with no object id or an unhandled type without calling Stripe, and an object naming no subscription after one call', async () => {
  const db = emptyDb()
  const client = routedClient({
    'GET /v1/checkout/sessions/cs_1': () => ({ id: 'cs_1', object: 'checkout.session', subscription: null }),
    'GET /v1/invoices/in_1': () => ({ id: 'in_1', object: 'invoice', parent: { type: 'subscription_details', subscription_details: {} } }),
  })
  const deps = { db, client, now: NOW }
  assertEquals(skipped(await projectStripeEvent(deps, { id: 'evt', type: 'customer.subscription.updated', objectId: null, objectType: null })), 'object_id_missing')
  assertEquals(skipped(await projectStripeEvent(deps, { id: 'evt', type: 'charge.refunded', objectId: 'ch_1', objectType: 'charge' })), 'event_not_handled')
  assertEquals(client.calls.length, 0)
  assertEquals(skipped(await projectStripeEvent(deps, { id: 'evt', type: 'checkout.session.completed', objectId: 'cs_1', objectType: 'checkout.session' })), 'no_subscription')
  assertEquals(skipped(await projectStripeEvent(deps, { id: 'evt', type: 'invoice.paid', objectId: 'in_1', objectType: 'invoice' })), 'no_subscription')
  assertEquals(client.calls.map((c) => c.path), ['/v1/checkout/sessions/cs_1', '/v1/invoices/in_1'])
  assertEquals(rowCounts(db), { payer: 0, subscription: 0, seat: 0 })
})

// --- T7 -------------------------------------------------------------------

test('T7 · current_period_end: on the subscription pre-basil, the latest item from basil on, the subscription when both', async () => {
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
  const item = (id: string, end?: number) => ({ id, object: 'subscription_item', quantity: 1, price: { id: 'price_S1' }, ...(end === undefined ? {} : { current_period_end: end }) })
  const cases: [string, Obj, string | null][] = [
    ['on the subscription', { current_period_end: 1_800_000_000 }, iso(1_800_000_000)],
    ['latest across items', { items: { object: 'list', has_more: false, data: [item('si_1', 1_800_000_000), item('si_2', 1_800_500_000)] } }, iso(1_800_500_000)],
    ['subscription wins over items', { current_period_end: 1_700_000_000, items: { object: 'list', has_more: false, data: [item('si_1', 1_800_000_000)] } }, iso(1_700_000_000)],
    ['neither', {}, null],
  ]
  for (const [label, overrides, expected] of cases) {
    const db = emptyDb()
    const client = routedClient({ [SUB_ROUTE]: () => stripeSubscription(overrides) })
    projected(await projectSubscriptionById({ db, client, now: NOW }, 'sub_1'))
    assertEquals(db.rows(subscription)[0]?.currentPeriodEnd, expected, label)
  }
})

test('T7 · an invoice names its subscription directly (pre-basil, id or object) or under parent.subscription_details (basil); invoice.paid is the literal', async () => {
  const shapes: [string, Obj][] = [
    ['subscription as id', { subscription: 'sub_1' }],
    ['subscription as object', { subscription: { id: 'sub_1', object: 'subscription' } }],
    ['basil parent', { parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } }],
  ]
  for (const [label, invoice] of shapes) {
    const db = emptyDb()
    const client = routedClient({
      'GET /v1/invoices/in_1': () => ({ id: 'in_1', object: 'invoice', ...invoice }),
      [SUB_ROUTE]: () => stripeSubscription(),
    })
    const outcome = projected(await projectStripeEvent({ db, client, now: NOW }, { id: 'evt', type: 'invoice.paid', objectId: 'in_1', objectType: 'invoice' }))
    assertEquals(outcome.subscriptionId, db.rows(subscription)[0]?.id, label)
    assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/invoices/in_1', 'GET /v1/subscriptions/sub_1'], label)
  }
})

test('T7 · checkout.session.completed reads the session first, then projects the subscription it names as an id or an object', async () => {
  for (const sessionSubscription of ['sub_1', { id: 'sub_1', object: 'subscription' }]) {
    const db = emptyDb()
    const client = routedClient({
      'GET /v1/checkout/sessions/cs_1': () => ({ id: 'cs_1', object: 'checkout.session', subscription: sessionSubscription }),
      [SUB_ROUTE]: () => stripeSubscription(),
    })
    projected(await projectStripeEvent({ db, client, now: NOW }, { id: 'evt', type: 'checkout.session.completed', objectId: 'cs_1', objectType: 'checkout.session' }))
    assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/checkout/sessions/cs_1', 'GET /v1/subscriptions/sub_1'])
    assertEquals(db.rows(subscriptionItem).map((row) => row.quantity), [2])
  }
})

test('T7 · items with has_more are walked through the list endpoint, and the page — not the embedded list — is what lands', async () => {
  const db = emptyDb()
  const client = routedClient({
    [SUB_ROUTE]: () =>
      stripeSubscription({
        items: { object: 'list', has_more: true, data: [{ id: 'si_1', object: 'subscription_item', quantity: 2, price: { id: 'price_S1' } }] },
      }),
    // Unexpanded price ids on the list endpoint project the same as `{ id }`.
    'GET /v1/subscription_items': () => ({
      object: 'list',
      data: [
        { id: 'si_1', object: 'subscription_item', quantity: 5, price: 'price_S1' },
        { id: 'si_2', object: 'subscription_item', quantity: 1, price: 'price_S2' },
      ],
    }),
  })
  projected(await projectSubscriptionById({ db, client, now: NOW }, 'sub_1'))
  const list = client.calls.find((c) => c.path === '/v1/subscription_items')!
  assertEquals(formOf(list, 'subscription'), 'sub_1')
  assertEquals(
    db.rows(subscriptionItem).map((row) => [row.providerItemId, row.tierId, row.quantity]).sort(),
    [['si_1', S1, 5], ['si_2', S2, 1]],
  )
})

test('T7 · schedule id or object, a missing quantity, and the first tax id all project as documented', async () => {
  const cases: [string, Obj, Obj, { scheduleId: string | null; quantity: number; taxId: string | null }][] = [
    ['schedule as id', { schedule: 'sub_sched_1' }, {}, { scheduleId: 'sub_sched_1', quantity: 2, taxId: 'DE123456789' }],
    ['schedule as object', { schedule: { id: 'sub_sched_2', object: 'subscription_schedule' } }, {}, { scheduleId: 'sub_sched_2', quantity: 2, taxId: 'DE123456789' }],
    ['quantity absent → 1', { items: { object: 'list', has_more: false, data: [{ id: 'si_1', object: 'subscription_item', price: { id: 'price_S1' } }] } }, {}, { scheduleId: null, quantity: 1, taxId: 'DE123456789' }],
    ['no tax ids', {}, { tax_ids: undefined }, { scheduleId: null, quantity: 2, taxId: null }],
  ]
  for (const [label, overrides, customerOverrides, expected] of cases) {
    const db = emptyDb()
    const client = routedClient({ [SUB_ROUTE]: () => stripeSubscription(overrides, customerOverrides) })
    projected(await projectSubscriptionById({ db, client, now: NOW }, 'sub_1'))
    assertEquals(db.rows(subscription)[0]?.scheduleId, expected.scheduleId, label)
    assertEquals(db.rows(subscriptionItem)[0]?.quantity, expected.quantity, label)
    assertEquals(db.rows(payer)[0]?.taxId, expected.taxId, label)
  }
})
