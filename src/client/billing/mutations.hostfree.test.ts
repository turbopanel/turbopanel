/**
 * Host-free coverage for the mutation bodies.
 *
 * Part one: an immediate seat increase is retry-safe — the idempotency key
 * Stripe saw is persisted before the call and replayed by the retry, so a
 * failure after Stripe accepted the update but before the reprojection
 * landed cannot buy the seats a second time. The projection runs for real
 * against the in-memory db; only the Stripe client is a double, and the
 * injected failure is its refetch (`get`) rejecting — the one call that
 * sits between "Stripe applied it" and "Postgres knows". The tier's price
 * is what the gateway says the product's default price is, never a value
 * on the row.
 *
 * Part two (ledger T1–T3): the tier moves and the seat decrease, against
 * the recording client double so the exact form Stripe receives is pinned
 * — an upgrade is an immediate −1/+1 item swap whose reprojection moves the
 * derived assignment (or leaves it alone when Stripe parked the change
 * under `pending_update`); a downgrade and a seat decrease write only the
 * ledger and a schedule phase, never a seat or server row; a Stripe
 * failure on either rolls the fresh intents back; and the coverage gate
 * refuses a reduction that would strand a licensed server or leave more
 * licenses held than purchased.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { StripeClient } from '../../lib/billing/client.ts'
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from '../../lib/billing/customer-subject.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import { type BillingGateway, NO_TAX_DEFAULTS, type ProviderProduct } from '../../lib/billing/gateway.ts'
import {
  emptyLedger,
  newDeferredIntent,
  readPendingChanges,
  withIntent,
  writePendingChanges,
} from '../../lib/billing/pending-changes.ts'
import { billingSeatIncreaseKey, parseSeatIncreaseRecord } from '../../lib/billing/seat-increase.ts'
import { verifyStripeProduct } from '../../lib/billing/stripe-products.ts'
import { license, organization, payer, server, setting, subscription, subscriptionItem, tier } from '../../lib/db/schema.ts'
import type { TierRow } from '../../lib/db/tier-records.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import { createStripeClientDouble, formOf, type StripeCall } from '../../test-fixtures/stripe-client.ts'
import { type BillingMutationOutcome, changeSeats, downgradeTier, upgradeTier } from './mutations.ts'
import {
  LICENSES_IN_USE_ERROR,
  loadBillingOrgView,
  NO_SUBSCRIPTION_ERROR,
  NOT_A_DOWNGRADE_ERROR,
  NOT_AN_UPGRADE_ERROR,
  SERVERS_UNCOVERED_ERROR,
  SUBSCRIPTION_PAST_DUE_ERROR,
  TIER_NOT_PURCHASABLE_ERROR,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S1 = '33333333-3333-4333-8333-333333333311'
const S3 = '33333333-3333-4333-8333-333333333331'
const S5 = '33333333-3333-4333-8333-333333333335'
const SRV_A = '55555555-5555-4555-8555-55555555555a'
const NOW = '2026-09-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
/** The projected `current_period_end`: what every deferred intent is parked behind. */
const PERIOD_END_ISO = '2026-10-01T00:00:00.000Z'
const PERIOD_END = Date.parse(PERIOD_END_ISO) / 1000
const PERIOD_START = PERIOD_END - 30 * 24 * 3600

const GIB = 1024 ** 3

/** A `tier` row as the table holds it now: a label bound to a product, plus a cached display price. */
function tierRow(id: string, label: 'S1' | 'S3' | 'S5', rank: number, priceCents: number): TierRow {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    label,
    rank,
    provider: 'stripe',
    providerProductId: `prod_${label.toLowerCase()}`,
    priceCents,
    currency: 'usd',
    isCustom: false,
    isActive: true,
  }
}

const TIER_S1 = tierRow(S1, 'S1', 1, 500)
const TIER_S3 = tierRow(S3, 'S3', 3, 1000)
const TIER_S5 = tierRow(S5, 'S5', 5, 2000)

/** The price each tier's product sells at — known only from the gateway, never stored on the row. */
const PRICE_BY_TIER: Record<string, string> = { [S1]: 'price_s1', [S3]: 'price_s3', [S5]: 'price_s5' }
const PRODUCT_BY_TIER: Record<string, string> = { [S1]: 'prod_s1', [S3]: 'prod_s3', [S5]: 'prod_s5' }

/** A Stripe Product with its default price expanded, satisfying every verification check. */
function stripeProduct(label: string, unitAmount: number) {
  const key = label.toLowerCase()
  return {
    id: `prod_${key}`,
    object: 'product',
    active: true,
    name: label,
    metadata: { turbopanel_tier: label },
    default_price: {
      id: `price_${key}`,
      object: 'price',
      active: true,
      type: 'recurring',
      currency: 'usd',
      unit_amount: unitAmount,
      recurring: { interval: 'month', interval_count: 1 },
      billing_scheme: 'per_unit',
      tax_behavior: 'exclusive',
      livemode: false,
    },
  }
}

const PRODUCTS: Record<string, unknown> = {
  prod_s1: stripeProduct('S1', 500),
  prod_s3: stripeProduct('S3', 1000),
  prod_s5: stripeProduct('S5', 2000),
}

/** Reported hardware, in the shape `touchServerMetadata` stores it. */
function hardware(cores: number, memoryGib: number) {
  return { resources: { cpus: [{ cores: { total: cores } }], memory: { totalBytes: memoryGib * GIB } } }
}

type SeatSeed = { tierId: string; providerItemId: string; quantity: number }
/** A licensed server: its hardware decides the rank it needs (12 cores → S3, 40 → S5, 2 → S1). */
type ServerSeed = { id: string; cores: number; memoryGib: number; createdAt?: string }

type OrgSeed = {
  seats?: SeatSeed[]
  /** Active licenses not yet bound to a server. */
  unboundLicenses?: number
  /** Each one holds a bound license. */
  servers?: ServerSeed[]
  status?: string
  /** `false`: a payer with no subscription row. */
  subscription?: boolean
}

/** One projected organization with the given seats, licenses and servers; S1, S3 and S5 in the catalogue. */
function orgDb(seed: OrgSeed = {}): MemoryDb {
  const servers = seed.servers ?? []
  const unbound = Array.from({ length: seed.unboundLicenses ?? 0 }, (_, i) => ({
    id: `lic-free-${i}`, organizationId: ORG, serverId: null, name: null, token: `tok-free-${i}`, revokedAt: null, createdAt: NOW, updatedAt: NOW,
  }))
  const bound = servers.map((row) => ({
    id: `lic-${row.id}`, organizationId: ORG, serverId: row.id, name: null, token: `tok-${row.id}`, revokedAt: null, createdAt: NOW, updatedAt: NOW,
  }))
  return createMemoryDb([
    [setting, []],
    [organization, [{ id: ORG, name: 'Billing Org', slug: null, metadata: null, options: null, createdAt: NOW, updatedAt: NOW }]],
    [payer, [{ id: 'payer-1', provider: 'stripe', providerCustomerId: 'cus_1', organizationId: ORG, userId: null, taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, seed.subscription === false ? [] : [{
      id: 'sub-row', payerId: 'payer-1', providerSubscriptionId: 'sub_1', status: seed.status ?? 'active',
      currentPeriodEnd: PERIOD_END_ISO, scheduleId: null, pastDueSince: null, graceExpiresAt: null, createdAt: NOW, updatedAt: NOW,
    }]],
    [subscriptionItem, (seed.seats ?? []).map((seat, i) => ({
      id: `seat-${i}`, subscriptionId: 'sub-row', tierId: seat.tierId, providerItemId: seat.providerItemId,
      providerPriceId: PRICE_BY_TIER[seat.tierId]!, quantity: seat.quantity, createdAt: NOW, updatedAt: NOW,
    }))],
    [tier, [TIER_S1, TIER_S3, TIER_S5]],
    [license, [...unbound, ...bound]],
    [server, servers.map((row) => ({
      id: row.id, organizationId: ORG, name: row.id, createdAt: row.createdAt ?? NOW, updatedAt: NOW,
      metadata: hardware(row.cores, row.memoryGib), assignedTierId: null, isConnected: false,
    }))],
  ])
}

type StripeItem = { id: string; tierId: string; quantity: number }

/**
 * The subscription as the projection refetches it: customer expanded with
 * the organization in its metadata, each item carrying its price and the
 * price's product — the projection maps items to tiers by product.
 */
function stripeSubscription(items: StripeItem[], opts: { pendingUpdate?: boolean } = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    status: 'active',
    schedule: null,
    current_period_end: PERIOD_END,
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
      data: items.map((item) => ({
        id: item.id,
        object: 'subscription_item',
        quantity: item.quantity,
        price: { id: PRICE_BY_TIER[item.tierId]!, product: PRODUCT_BY_TIER[item.tierId]! },
      })),
    },
  }
}

function depsFor(db: MemoryDb, client: StripeClient, gateway?: BillingGateway) {
  const leases: string[] = []
  return {
    leases,
    deps: {
      db,
      client,
      ...(gateway ? { gateway } : {}),
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

async function ledgerOf(db: MemoryDb) {
  return (await readPendingChanges(db, ORG, 'sub_1')).ledger
}

function seatQuantities(db: MemoryDb): Record<string, number> {
  return Object.fromEntries(db.rows(subscriptionItem).map((row) => [row.tierId, row.quantity]))
}

function assignedTier(db: MemoryDb, serverId: string): string | null {
  return (db.rows(server).find((row) => row.id === serverId)?.assignedTierId as string | null | undefined) ?? null
}

/** Narrow a mutation outcome to its refusal body, failing loudly on a success. */
function refusalOf<T extends Record<string, unknown>>(outcome: BillingMutationOutcome<T>) {
  if (outcome.ok) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.body)}`)
  return { status: outcome.status, body: outcome.body }
}

// ---------------------------------------------------------------------------
// Part one: the immediate seat increase and its retry record.
// ---------------------------------------------------------------------------

type Post = { path: string; idempotencyKey: string | undefined; body: Record<string, unknown> | undefined }

/**
 * A Stripe double whose `post` records every idempotency key and whose
 * subscription refetch (`get`) fails the first `failRefetches` times — the
 * injected gap between Stripe accepting the update and the reprojection
 * completing. Products are answered from the catalogue above, so the real
 * gateway runs over it. `trace` is every call in order.
 */
function stripeDouble(opts: { failRefetches?: number; postError?: () => Error; onPost?: () => void } = {}) {
  const posts: Post[] = []
  const trace: string[] = []
  let refetches = 0
  let committedQuantity = 2
  const client: StripeClient = {
    get: (path) => {
      trace.push(`GET ${path}`)
      if (path.startsWith('/v1/products/')) {
        const product = PRODUCTS[path.slice('/v1/products/'.length)]
        return product ? Promise.resolve(product as never) : Promise.reject(new Error(`unexpected product ${path}`))
      }
      if (!path.startsWith('/v1/subscriptions/sub_1')) return Promise.reject(new Error(`unexpected get ${path}`))
      refetches += 1
      if (refetches <= (opts.failRefetches ?? 0)) return Promise.reject(new Error('injected: refetch failed'))
      return Promise.resolve(stripeSubscription([{ id: 'si_1', tierId: S3, quantity: committedQuantity }]) as never)
    },
    post: (path, body, mutation) => {
      trace.push(`POST ${path}`)
      posts.push({ path, idempotencyKey: mutation?.idempotencyKey, body })
      opts.onPost?.()
      if (opts.postError) return Promise.reject(opts.postError())
      // Stripe applied the update: the next refetch shows the quantity it was sent.
      const [first] = body?.items as { quantity: number }[]
      committedQuantity = first!.quantity
      return Promise.resolve({ id: 'sub_1', object: 'subscription', status: 'active' } as never)
    },
    del: (path) => Promise.reject(new Error(`unexpected del ${path}`)),
    listAll: (path) => Promise.reject(new Error(`unexpected listAll ${path}`)),
  }
  return { client, posts, trace }
}

/** Two S3 seats, nothing licensed. */
const twoSeats = (): OrgSeed => ({ seats: [{ tierId: S3, providerItemId: 'si_1', quantity: 2 }] })

test('a seat increase whose reprojection fails after Stripe accepted it is retried under the SAME idempotency key, then the record is cleared', async () => {
  const db = orgDb(twoSeats())
  const atPost: { record: ReturnType<typeof storedRecord> } = { record: null }
  const { client, posts, trace } = stripeDouble({ failRefetches: 1, onPost: () => (atPost.record = storedRecord(db)) })
  const { deps, leases } = depsFor(db, client)
  const input = { organizationId: ORG, tierId: S3, delta: 1, prorationDate: 1_800_000_000 }

  // Attempt 1: Stripe accepts the update; the reprojection's refetch fails.
  await assertRejects(() => changeSeats(deps, input), Error, 'injected: refetch failed')
  assertEquals(posts.length, 1)
  assertEquals(posts[0]?.path, '/v1/subscriptions/sub_1')
  // The product's default price is resolved through the gateway before the write.
  assertEquals(trace, ['GET /v1/products/prod_s3', 'POST /v1/subscriptions/sub_1', 'GET /v1/subscriptions/sub_1'])
  const firstKey = posts[0]?.idempotencyKey
  assertEquals(typeof firstKey, 'string')
  // The record was on disk when Stripe was called, carrying that very key…
  assertEquals(atPost.record?.idempotencyKey, firstKey)
  // …and it survived the failure, with the deltas, items and proration date Stripe saw.
  const record = storedRecord(db)
  assertEquals(record?.idempotencyKey, firstKey)
  assertEquals(record?.prorationDate, 1_800_000_000)
  assertEquals(record?.deltas, [{ tierId: S3, delta: 1 }])
  assertEquals(record?.items, [{ id: 'si_1', quantity: 3 }])
  assertEquals(record?.providerSubscriptionId, 'sub_1')
  // Postgres still says two seats: entitlement did not move on a failed projection.
  assertEquals(seatQuantities(db), { [S3]: 2 })
  assertEquals(leases, ['begin', 'end'])

  // Attempt 2 — the console's retry, same request, no proration date this time.
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 })
  assertEquals(outcome.ok, true)
  assertEquals(posts.length, 2)
  // Same key, the same items and the same pinned proration date: Stripe replays, it does not re-apply.
  assertEquals(posts[1]?.idempotencyKey, firstKey)
  assertEquals(posts[1]?.body?.proration_date, 1_800_000_000)
  assertEquals(posts[0]?.body, posts[1]?.body)
  // The reprojection landed the committed quantity and consumed the record.
  assertEquals(seatQuantities(db), { [S3]: 3 })
  assertEquals(storedRecord(db), null)
  assertEquals(leases, ['begin', 'end', 'begin', 'end'])
})

test('a permanent Stripe refusal clears the record, so the next attempt is a fresh request with a new key', async () => {
  const db = orgDb(twoSeats())
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
  assertEquals(seatQuantities(db), { [S3]: 2 })
})

test('a transient Stripe failure keeps the record: the retry presents the same key', async () => {
  const db = orgDb(twoSeats())
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
  assertEquals(posts[1]?.body, posts[0]?.body)
})

test('a different request after a transient failure is not a retry: it gets its own key and replaces the record', async () => {
  const db = orgDb(twoSeats())
  const { client, posts } = stripeDouble({ failRefetches: 1 })
  const { deps } = depsFor(db, client)
  await assertRejects(() => changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 }), Error, 'injected: refetch failed')
  const first = storedRecord(db)
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 2 })
  assertEquals(outcome.ok, true)
  assertEquals(posts.length, 2)
  assertEquals(posts[1]?.idempotencyKey === first?.idempotencyKey, false)
  assertEquals(posts[1]?.body?.items, [{ id: 'si_1', quantity: 4 }])
  assertEquals(storedRecord(db), null)
})

test('a seat increase succeeding first time is invoiced now under pending_if_incomplete and leaves no record behind', async () => {
  const db = orgDb(twoSeats())
  const { client, posts } = stripeDouble()
  const { deps } = depsFor(db, client)
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body, { ok: true, pending: false, deferred: false })
  assertEquals(posts.length, 1)
  assertEquals(posts[0]?.body?.proration_behavior, 'always_invoice')
  assertEquals(posts[0]?.body?.payment_behavior, 'pending_if_incomplete')
  assertEquals(posts[0]?.body?.proration_date, Math.floor(NOW_MS / 1000))
  assertEquals(storedRecord(db), null)
  assertEquals(seatQuantities(db), { [S3]: 3 })
})

test('a retry replays the stored items even after a webhook moved the seat rows meanwhile — never items rebuilt from the new rows', async () => {
  const db = orgDb(twoSeats())
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
  assertEquals(seatQuantities(db), { [S3]: 3 })
})

test('a seat increase is refused before any Stripe call or record: 409 subscription_past_due while delinquent (C8), 409 no_subscription without one', async () => {
  const pastDue = orgDb({ ...twoSeats(), status: 'past_due' })
  const { client, trace } = stripeDouble()
  const denied = refusalOf(await changeSeats(depsFor(pastDue, client).deps, { organizationId: ORG, tierId: S3, delta: 1 }))
  assertEquals(denied.status, 409)
  assertEquals(denied.body.error, SUBSCRIPTION_PAST_DUE_ERROR)
  assertEquals(storedRecord(pastDue), null)

  const none = orgDb({ subscription: false })
  const missing = refusalOf(await changeSeats(depsFor(none, client).deps, { organizationId: ORG, tierId: S3, delta: 1 }))
  assertEquals(missing.status, 409)
  assertEquals(missing.body, { error: NO_SUBSCRIPTION_ERROR })

  // A decrease with nothing to decrease answers the same way.
  const release = refusalOf(await changeSeats(depsFor(none, client).deps, { organizationId: ORG, tierId: S3, delta: -1 }))
  assertEquals(release.status, 409)
  assertEquals(release.body, { error: NO_SUBSCRIPTION_ERROR })

  // An ended subscription reads as none.
  const ended = orgDb({ ...twoSeats(), status: 'canceled' })
  const gone = refusalOf(await changeSeats(depsFor(ended, client).deps, { organizationId: ORG, tierId: S3, delta: 1 }))
  assertEquals(gone.body, { error: NO_SUBSCRIPTION_ERROR })

  assertEquals(trace, [])
})

test('a tier whose product no longer sells is refused 400 tier_not_purchasable through the injected gateway, before any record or Stripe write', async () => {
  const db = orgDb(twoSeats())
  const asked: string[] = []
  const unsellable: ProviderProduct = {
    id: 'prod_s3', name: 'S3', active: true, livemode: false, metadata: {}, suggestedLabel: 'S3', defaultPrice: null,
  }
  const gateway: BillingGateway = {
    id: 'stripe',
    listProducts: () => Promise.resolve([]),
    getProduct: (productId) => {
      asked.push(productId)
      return Promise.resolve(unsellable)
    },
    getTaxDefaults: () => Promise.resolve(NO_TAX_DEFAULTS),
    verifyProduct: verifyStripeProduct,
  }
  const { client, trace } = stripeDouble()
  const { deps } = depsFor(db, client, gateway)
  const denied = refusalOf(await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: 1 }))
  assertEquals(denied.status, 400)
  assertEquals(denied.body.error, TIER_NOT_PURCHASABLE_ERROR)
  assertEquals(denied.body.reason, 'product_unsellable')
  assertEquals((denied.body.failures as string[]).length > 0, true)
  // The injected gateway answered the product; the client saw nothing.
  assertEquals(asked, ['prod_s3'])
  assertEquals(trace, [])
  assertEquals(storedRecord(db), null)
})

// ---------------------------------------------------------------------------
// T1–T3: tier moves and the seat decrease, on the recording client double.
// ---------------------------------------------------------------------------

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

/**
 * A client double answering by `METHOD path`; the product catalogue is
 * always there (the gateway reads it), anything else unlisted is a test bug.
 */
function routedClient(routes: Partial<Record<Route, (call: StripeCall) => unknown>>) {
  return createStripeClientDouble((call) => {
    const handler = routes[`${call.method} ${call.path}` as Route]
    if (handler) return handler(call)
    if (call.method === 'GET' && call.path.startsWith('/v1/products/')) {
      const product = PRODUCTS[call.path.slice('/v1/products/'.length)]
      if (product) return product
    }
    throw new Error(`unexpected Stripe call ${call.method} ${call.path}`)
  })
}

function callsOf(client: ReturnType<typeof routedClient>): string[] {
  return client.calls.map((c) => `${c.method} ${c.path}`)
}

/** Every `phases[n][items][m][<field>]` key of a schedule write. */
function phaseItemFields(call: StripeCall): string[] {
  return call.form
    .map(([key]) => /^phases\[\d+\]\[items\]\[\d+\]\[(.+)\]$/.exec(key)?.[1])
    .filter((field): field is string => field !== undefined)
}

test('a seat increase on a tier with no item yet mints the item at the product\'s default price from the gateway and refreshes the cached display price', async () => {
  const db = orgDb({ ...twoSeats(), servers: [{ id: SRV_A, cores: 40, memoryGib: 64 }] })
  // The row's cache is stale: what Stripe is sent must come from the product, not from here.
  db.rows(tier).find((row) => row.id === S5)!.priceCents = 1
  const client = routedClient({
    'POST /v1/subscriptions/sub_1': () => ({ id: 'sub_1', object: 'subscription', status: 'active' }),
    'GET /v1/subscriptions/sub_1': () => stripeSubscription([
      { id: 'si_1', tierId: S3, quantity: 2 },
      { id: 'si_2', tierId: S5, quantity: 1 },
    ]),
  })
  const { deps } = depsFor(db, client)
  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S5, delta: 1 })
  assertEquals(outcome.ok, true)
  assertEquals(callsOf(client), ['GET /v1/products/prod_s5', 'POST /v1/subscriptions/sub_1', 'GET /v1/subscriptions/sub_1'])
  const [product, post] = client.calls as [StripeCall, StripeCall]
  assertEquals(formOf(product, 'expand[0]'), 'default_price')
  assertEquals(formOf(post, 'items[0][id]'), 'si_1')
  assertEquals(formOf(post, 'items[0][quantity]'), '2')
  assertEquals(formOf(post, 'items[1][price]'), 'price_s5')
  assertEquals(formOf(post, 'items[1][quantity]'), '1')
  assertEquals(db.rows(tier).find((row) => row.id === S5)?.priceCents, 2000)
  // The reprojection wrote the new seat and the assignment followed: the S5 server is covered now.
  assertEquals(seatQuantities(db), { [S3]: 2, [S5]: 1 })
  assertEquals(db.rows(subscriptionItem).find((row) => row.tierId === S5)?.providerPriceId, 'price_s5')
  assertEquals(assignedTier(db, SRV_A), S5)
  assertEquals(storedRecord(db), null)
})

// --- T1 -------------------------------------------------------------------

test('T1 · an upgrade is an immediate −1/+1 item swap under the seat-increase record; the reprojection moves the assignment', async () => {
  // Two S3 seats; one server that S3 cannot cover and is therefore on nothing.
  const db = orgDb({ ...twoSeats(), servers: [{ id: SRV_A, cores: 40, memoryGib: 64 }] })
  const atPost: { record: ReturnType<typeof storedRecord> } = { record: null }
  const client = routedClient({
    'POST /v1/subscriptions/sub_1': () => {
      atPost.record = storedRecord(db)
      return { id: 'sub_1', object: 'subscription', status: 'active' }
    },
    'GET /v1/subscriptions/sub_1': () => stripeSubscription([
      { id: 'si_1', tierId: S3, quantity: 1 },
      { id: 'si_2', tierId: S5, quantity: 1 },
    ]),
  })
  const { deps, leases } = depsFor(db, client)
  assertEquals(assignedTier(db, SRV_A), null)

  const outcome = await upgradeTier(deps, { organizationId: ORG, fromTierId: S3, toTierId: S5, prorationDate: 1_800_000_000 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body, { ok: true, pending: false })

  // The target's price came from the gateway; exactly one write; then the reprojection's refetch.
  assertEquals(callsOf(client), ['GET /v1/products/prod_s5', 'POST /v1/subscriptions/sub_1', 'GET /v1/subscriptions/sub_1'])
  const post = client.calls[1]!
  // The record carried the swap and its key when Stripe was called.
  assertEquals(atPost.record?.deltas, [{ tierId: S3, delta: -1 }, { tierId: S5, delta: 1 }])
  assertEquals(post.idempotencyKey, atPost.record?.idempotencyKey)
  assertEquals(formOf(post, 'payment_behavior'), 'pending_if_incomplete')
  assertEquals(formOf(post, 'proration_behavior'), 'always_invoice')
  assertEquals(formOf(post, 'proration_date'), '1800000000')
  // The source item carries its id AND its new quantity (never id alone),
  // the target is a new item by price.
  assertEquals(formOf(post, 'items[0][id]'), 'si_1')
  assertEquals(formOf(post, 'items[0][quantity]'), '1')
  assertEquals(formOf(post, 'items[1][price]'), 'price_s5')
  assertEquals(formOf(post, 'items[1][quantity]'), '1')
  assertEquals(formOf(post, 'items[0][price]'), undefined)

  // The committed items show the swap, so the sync placed the server on S5
  // and the record is gone — the webhook that follows is redundant.
  assertEquals(seatQuantities(db), { [S3]: 1, [S5]: 1 })
  assertEquals(assignedTier(db, SRV_A), S5)
  assertEquals(storedRecord(db), null)
  assertEquals((await ledgerOf(db)).intents, [])
  assertEquals(leases, ['begin', 'end'])
})

test('T1 · an upgrade Stripe parks under pending_update answers pending and leaves seats and the assignment where they were', async () => {
  const db = orgDb({ ...twoSeats(), servers: [{ id: SRV_A, cores: 40, memoryGib: 64 }] })
  const client = routedClient({
    'POST /v1/subscriptions/sub_1': () => ({ id: 'sub_1', object: 'subscription', status: 'active', pending_update: { expires_at: 1 } }),
    'GET /v1/subscriptions/sub_1': () => stripeSubscription([{ id: 'si_1', tierId: S3, quantity: 2 }], { pendingUpdate: true }),
  })
  const { deps } = depsFor(db, client)
  const outcome = await upgradeTier(deps, { organizationId: ORG, fromTierId: S3, toTierId: S5 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body.pending, true)
  // Entitlement did not move: Stripe has not charged for it yet.
  assertEquals(seatQuantities(db), { [S3]: 2 })
  assertEquals(assignedTier(db, SRV_A), null)
  // The reprojection ran, so the record has done its job.
  assertEquals(storedRecord(db), null)
})

test('T1 · refusals: past due (C8), not an upgrade, the same tier, and a source tier with no seat to give', async () => {
  // Past due: the C8 gate, with the grace deadline in the body, before any Stripe call.
  const pastDue = orgDb({ ...twoSeats(), status: 'past_due' })
  const client = routedClient({})
  const denied = refusalOf(await upgradeTier(depsFor(pastDue, client).deps, { organizationId: ORG, fromTierId: S3, toTierId: S5 }))
  assertEquals(denied.status, 409)
  assertEquals(denied.body.error, SUBSCRIPTION_PAST_DUE_ERROR)
  assertEquals(storedRecord(pastDue), null)
  assertEquals(client.calls, [])

  // Not an upgrade: S5 → S3 through the upgrade path, refused before the lease.
  const db = orgDb(twoSeats())
  const { deps, leases } = depsFor(db, client)
  const wrongWay = refusalOf(await upgradeTier(deps, { organizationId: ORG, fromTierId: S5, toTierId: S3 }))
  assertEquals(wrongWay.status, 400)
  assertEquals(wrongWay.body, { error: NOT_AN_UPGRADE_ERROR })
  const same = refusalOf(await upgradeTier(deps, { organizationId: ORG, fromTierId: S3, toTierId: S3 }))
  assertEquals(same.status, 400)
  assertEquals(same.body, { error: 'Invalid request' })
  assertEquals(leases, [])
  assertEquals(client.calls, [])

  // S1 → S5 when nothing is held at S1: the item arithmetic refuses it.
  const empty = refusalOf(await upgradeTier(deps, { organizationId: ORG, fromTierId: S1, toTierId: S5 }))
  assertEquals(empty.status, 400)
  assertEquals(empty.body, { error: 'Invalid request' })
  assertEquals(callsOf(client).filter((c) => c.startsWith('POST')), [])
  assertEquals(storedRecord(db), null)
})

// --- T2 -------------------------------------------------------------------

test('T2 · a downgrade writes one downgrade intent and a schedule phase for the boundary; seats and the assignment stay put', async () => {
  // The target tier has no seat line yet, so the future phase must mint a new item by price.
  const db = orgDb({ seats: [{ tierId: S5, providerItemId: 'si_5', quantity: 1 }], servers: [{ id: SRV_A, cores: 12, memoryGib: 32 }] })
  db.rows(server)[0]!.assignedTierId = S5
  const client = routedClient({
    'POST /v1/subscription_schedules': () => stripeSchedule([{ price: 'price_s5', quantity: 1 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_s5', quantity: 1 }]),
  })
  const { deps, leases } = depsFor(db, client)

  const outcome = await downgradeTier(deps, { organizationId: ORG, fromTierId: S5, toTierId: S3 })
  assertEquals(outcome.ok, true)
  if (!outcome.ok) return
  assertEquals(outcome.body.deferred, true)
  assertEquals(outcome.body.scheduleId, 'sub_sched_1')

  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 1)
  const intent = ledger.intents[0]!
  assertEquals(intent.kind, 'downgrade')
  assertEquals(intent.fromTierId, S5)
  assertEquals(intent.toTierId, S3)
  assertEquals(intent.landsAt, PERIOD_END_ISO)
  assertEquals(intent.fromQuantity, 1)
  assertEquals(intent.createdAt, NOW)
  assertEquals(outcome.body.intentId, intent.id)

  // Nothing moved now: the boundary does that.
  assertEquals(seatQuantities(db), { [S5]: 1 })
  assertEquals(assignedTier(db, SRV_A), S5)
  assertEquals(storedRecord(db), null)

  // The target's price from the gateway, a schedule from the subscription, then every phase rewritten.
  assertEquals(callsOf(client), ['GET /v1/products/prod_s3', 'POST /v1/subscription_schedules', 'POST /v1/subscription_schedules/sub_sched_1'])
  const [, create, phases] = client.calls as [StripeCall, StripeCall, StripeCall]
  assertEquals(formOf(create, 'from_subscription'), 'sub_1')
  assertEquals(create.idempotencyKey, `${intent.idempotencyKey}:schedule`)
  assertEquals(phases.idempotencyKey, `${intent.idempotencyKey}:phases`)
  assertEquals(formOf(phases, 'end_behavior'), 'release')
  // The current phase restated with its own dates and items…
  assertEquals(formOf(phases, 'phases[0][start_date]'), String(PERIOD_START))
  assertEquals(formOf(phases, 'phases[0][end_date]'), String(PERIOD_END))
  assertEquals(formOf(phases, 'phases[0][items][0][price]'), 'price_s5')
  assertEquals(formOf(phases, 'phases[0][items][0][quantity]'), '1')
  // …then one contiguous future phase, one month long, holding only the target.
  assertEquals(formOf(phases, 'phases[1][start_date]'), String(PERIOD_END))
  assertEquals(formOf(phases, 'phases[1][duration][interval]'), 'month')
  assertEquals(formOf(phases, 'phases[1][duration][interval_count]'), '1')
  assertEquals(formOf(phases, 'phases[1][items][0][price]'), 'price_s3')
  assertEquals(formOf(phases, 'phases[1][items][0][quantity]'), '1')
  assertEquals(formOf(phases, 'phases[1][items][1][price]'), undefined)
  // Phase items carry price and quantity only — never an item id.
  assertEquals(new Set(phaseItemFields(phases)), new Set(['price', 'quantity']))
  assertEquals(leases, ['begin', 'end'])
})

test('T2 · a Stripe failure rolls a fresh downgrade intent back; a later attempt parks a new intent under its own key', async () => {
  const db = orgDb({ seats: [{ tierId: S5, providerItemId: 'si_5', quantity: 1 }] })
  let fail = true
  const client = routedClient({
    'POST /v1/subscription_schedules': () => {
      if (fail) throw new StripeApiError({ status: 503, type: 'api_error', message: 'try again' })
      return stripeSchedule([{ price: 'price_s5', quantity: 1 }])
    },
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_s5', quantity: 1 }]),
  })
  const { deps, leases } = depsFor(db, client)
  const input = { organizationId: ORG, fromTierId: S5, toTierId: S3 }

  await assertRejects(() => downgradeTier(deps, input), StripeApiError)
  // Nothing is parked on the provider, so nothing stays in the ledger.
  assertEquals((await ledgerOf(db)).intents, [])
  assertEquals(seatQuantities(db), { [S5]: 1 })
  assertEquals(leases, ['begin', 'end'])

  fail = false
  const outcome = await downgradeTier(deps, input)
  assertEquals(outcome.ok, true)
  assertEquals((await ledgerOf(db)).intents.length, 1)
  const creates = client.calls.filter((c) => c.path === '/v1/subscription_schedules')
  assertEquals(creates.length, 2)
  assertEquals(creates[0]!.idempotencyKey === creates[1]!.idempotencyKey, false)
})

test('T2 · refusals: not a downgrade, and 409 servers_uncovered when a licensed server needs the higher tier', async () => {
  const client = routedClient({})
  const up = orgDb({ seats: [{ tierId: S3, providerItemId: 'si_1', quantity: 1 }] })
  const wrongWay = refusalOf(await downgradeTier(depsFor(up, client).deps, { organizationId: ORG, fromTierId: S3, toTierId: S5 }))
  assertEquals(wrongWay.status, 400)
  assertEquals(wrongWay.body, { error: NOT_A_DOWNGRADE_ERROR })
  assertEquals(client.calls, [])

  // One S5 seat covering one server that needs S5: S5 → S3 would strand it.
  const db = orgDb({ seats: [{ tierId: S5, providerItemId: 'si_5', quantity: 1 }], servers: [{ id: SRV_A, cores: 40, memoryGib: 64 }] })
  const { deps, leases } = depsFor(db, client)
  const denied = refusalOf(await downgradeTier(deps, { organizationId: ORG, fromTierId: S5, toTierId: S3 }))
  assertEquals(denied.status, 409)
  assertEquals(denied.body, { error: SERVERS_UNCOVERED_ERROR, serverId: SRV_A, requiredTier: 'S5' })
  // The target's price was resolved (the gate runs after it); nothing was written to the provider.
  assertEquals(callsOf(client).filter((c) => c.startsWith('POST')), [])
  assertEquals((await ledgerOf(db)).intents, [])
  assertEquals(leases, ['begin', 'end'])
})

// --- T3 -------------------------------------------------------------------

test('T3 · a seat decrease is one release-seat intent per seat, parked behind the period end, plus a schedule phase at the reduced quantity; seats are untouched', async () => {
  const db = orgDb({ seats: [{ tierId: S3, providerItemId: 'si_1', quantity: 3 }], unboundLicenses: 1 })
  const client = routedClient({
    'POST /v1/subscription_schedules': () => stripeSchedule([{ price: 'price_s3', quantity: 3 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_s3', quantity: 3 }]),
  })
  const { deps, leases } = depsFor(db, client)

  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: -2 })
  assertEquals(outcome.ok, true)
  assertEquals(outcome.ok && outcome.body, { ok: true, pending: false, deferred: true, scheduleId: 'sub_sched_1' })

  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 2)
  for (const intent of ledger.intents) {
    assertEquals(intent.kind, 'release-seat')
    assertEquals(intent.fromTierId, S3)
    assertEquals(intent.toTierId, null)
    assertEquals(intent.landsAt, PERIOD_END_ISO)
    assertEquals(intent.fromQuantity, 3)
  }
  assertEquals(new Set(ledger.intents.map((i) => i.id)).size, 2)

  assertEquals(seatQuantities(db), { [S3]: 3 })
  // No product lookup: every price the phase needs is on the seats already.
  assertEquals(callsOf(client), ['POST /v1/subscription_schedules', 'POST /v1/subscription_schedules/sub_sched_1'])
  const [create, phases] = client.calls as [StripeCall, StripeCall]
  assertEquals(create.idempotencyKey, `${ledger.intents[0]!.idempotencyKey}:schedule`)
  assertEquals(formOf(phases, 'phases[1][items][0][price]'), 'price_s3')
  assertEquals(formOf(phases, 'phases[1][items][0][quantity]'), '1')
  assertEquals(formOf(phases, 'phases[1][items][1][price]'), undefined)
  assertEquals(leases, ['begin', 'end'])
})

test('T3 · a second release stacks on the parked one: the future phase is rebuilt from the whole ledger', async () => {
  const db = orgDb({ seats: [{ tierId: S3, providerItemId: 'si_1', quantity: 3 }] })
  const parked = newDeferredIntent('release-seat', { fromTierId: S3, toTierId: null, landsAt: PERIOD_END_ISO, fromQuantity: 3, nowMs: NOW_MS })
  await writePendingChanges(db, ORG, withIntent(emptyLedger('sub_1'), parked), NOW_MS)
  const client = routedClient({
    'POST /v1/subscription_schedules': () => stripeSchedule([{ price: 'price_s3', quantity: 3 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => stripeSchedule([{ price: 'price_s3', quantity: 3 }]),
  })
  const { deps } = depsFor(db, client)

  const outcome = await changeSeats(deps, { organizationId: ORG, tierId: S3, delta: -1 })
  assertEquals(outcome.ok, true)
  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 2)
  assertEquals(ledger.intents[0]!.id, parked.id)
  // Both releases in one phase: three seats minus two.
  const phases = client.calls[1]!
  assertEquals(formOf(phases, 'phases[1][items][0][quantity]'), '1')
  assertEquals(seatQuantities(db), { [S3]: 3 })
})

test('T3 · a decrease that would strand a licensed server is refused 409 servers_uncovered naming the server and the tier it needs, before any Stripe call', async () => {
  // One S3 and one S1 seat; the only server needs S3. Releasing S3 leaves S1, which cannot hold it.
  const db = orgDb({
    seats: [{ tierId: S1, providerItemId: 'si_a', quantity: 1 }, { tierId: S3, providerItemId: 'si_1', quantity: 1 }],
    servers: [{ id: SRV_A, cores: 12, memoryGib: 32 }],
  })
  const client = routedClient({})
  const outcome = refusalOf(await changeSeats(depsFor(db, client).deps, { organizationId: ORG, tierId: S3, delta: -1 }))
  assertEquals(outcome.status, 409)
  assertEquals(outcome.body, { error: SERVERS_UNCOVERED_ERROR, serverId: SRV_A, requiredTier: 'S3' })
  assertEquals(client.calls, [])
  assertEquals((await ledgerOf(db)).intents, [])
})

test('T3 · a decrease below the licenses held is refused 409 licenses_in_use with the counts, before any Stripe call', async () => {
  const db = orgDb({ seats: [{ tierId: S3, providerItemId: 'si_1', quantity: 3 }], unboundLicenses: 2 })
  const client = routedClient({})
  const outcome = refusalOf(await changeSeats(depsFor(db, client).deps, { organizationId: ORG, tierId: S3, delta: -2 }))
  assertEquals(outcome.status, 409)
  assertEquals(outcome.body, { error: LICENSES_IN_USE_ERROR, purchasedAfter: 1, licensesHeld: 2 })
  assertEquals(client.calls, [])
  assertEquals((await ledgerOf(db)).intents, [])
})

test('T3 · a Stripe rejection of the decrease rolls back exactly the intents it added and rethrows', async () => {
  const db = orgDb({ seats: [{ tierId: S3, providerItemId: 'si_1', quantity: 4 }], unboundLicenses: 1 })
  // An unrelated intent already in the ledger must survive the rollback.
  const parked = newDeferredIntent('release-seat', { fromTierId: S3, toTierId: null, landsAt: PERIOD_END_ISO, fromQuantity: 4, nowMs: NOW_MS })
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
