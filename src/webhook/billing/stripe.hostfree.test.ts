/**
 * Route-gate coverage for the Stripe webhook surface.
 *
 * Host-free: the only database work before the answer is the delivery-claim
 * insert, and the projection runs *after* the response through the
 * `schedule` seam, against a stub ledger and an injected Stripe `fetch`.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { STRIPE_WEBHOOK_PATH } from '../../surfaces.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import { createStripeClient, type StripeFetch } from '../../lib/billing/client.ts'
import { computeStripeSignature } from '../../lib/billing/webhook-signature.ts'
import { STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY } from '../../lib/billing/customer-subject.ts'
import { license, payer, server, setting, subscription, subscriptionItem, tier, webhookDelivery } from '../../lib/db/schema.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import { emptyLedger, newDeferredIntent, readPendingChanges, withIntent, writePendingChanges } from '../../lib/billing/pending-changes.ts'
import { registerWebhookRoutes } from '../routes.ts'
import { PROJECTED_STRIPE_EVENT_TYPES, projectSubscriptionById } from './stripe-projection.ts'
import {
  registerStripeWebhookRoutes,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_NOT_CONFIGURED,
} from './stripe.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SIGNING_SECRET = 'whsec_test_0123456789abcdef'
const ORG_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const TIER_ID = '11111111-1111-4111-8111-111111111111'

const CONFIG: BillingConfig = {
  secretKey: 'sk_test_x',
  webhookSigningSecret: SIGNING_SECRET,
  apiVersion: '2025-08-27.basil',
}

type Trace = string[]

type StubDb = MemoryDb & { inserts: { table: string; values: Record<string, unknown> }[] }

function tableName(table: unknown): string {
  if (table === webhookDelivery) return 'delivery'
  if (table === payer) return 'payer'
  if (table === subscription) return 'subscription'
  if (table === subscriptionItem) return 'seat'
  if (table === tier) return 'tier'
  if (table === setting) return 'setting'
  return 'unknown'
}

/** A tier row is a ladder label bound to a provider product; the item's price names that product. */
const TIER_ROW = {
  id: TIER_ID, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  label: 'S1', rank: 1, provider: 'stripe', providerProductId: 'prod_s1', priceCents: 1000, currency: 'usd', isCustom: false, isActive: true,
}

/**
 * The in-memory projection: the ledger claim, `payer` → `subscription` →
 * `seat`, and everything the entitlement sync touches afterwards. `trace`
 * records the writes the gate tests assert on (`insert:` / `delete:` of
 * the projection tables, plus the delivery claim) in order.
 */
function stubDb(trace: Trace, opts: { claimed?: boolean; licenses?: Record<string, unknown>[] } = {}): StubDb {
  const db = createMemoryDb([
    [webhookDelivery, opts.claimed === false ? [{ id: 'd0', provider: 'stripe', externalDeliveryId: 'evt_1', event: 'x', createdAt: 'c', updatedAt: 'c' }] : []],
    [payer, []],
    [subscription, []],
    [subscriptionItem, []],
    [tier, [TIER_ROW]],
    [license, opts.licenses ?? []],
    [server, []],
    [setting, []],
  ])
  const inserts: { table: string; values: Record<string, unknown> }[] = []
  const origInsert = db.insert.bind(db)
  const origDelete = db.delete.bind(db)
  const traced = Object.assign(db, {
    inserts,
    insert: (table: unknown) => {
      const chain = origInsert(table as Parameters<typeof origInsert>[0])
      return {
        values: (values: Record<string, unknown>) => {
          const name = tableName(table)
          if (name !== 'unknown') {
            inserts.push({ table: name, values })
            trace.push(`insert:${name}`)
          }
          return chain.values(values)
        },
      }
    },
    delete: (table: unknown) => {
      const name = tableName(table)
      if (name !== 'unknown') trace.push(`delete:${name}`)
      return origDelete(table as Parameters<typeof origDelete>[0])
    },
  })
  return traced as unknown as StubDb
}

const SUBSCRIPTION_FROM_STRIPE = {
  id: 'sub_1',
  object: 'subscription',
  status: 'active',
  schedule: null,
  customer: {
    id: 'cus_1',
    object: 'customer',
    metadata: { [STRIPE_CUSTOMER_ORGANIZATION_METADATA_KEY]: ORG_ID },
    tax_ids: { object: 'list', data: [{ value: 'DE123456789' }], has_more: false },
  },
  items: {
    object: 'list',
    has_more: false,
    data: [
      { id: 'si_1', object: 'subscription_item', quantity: 4, price: { id: 'price_s1', product: 'prod_s1' }, current_period_end: 1_800_000_000 },
    ],
  },
}

/** `GET /v1/products/prod_s1?expand[]=default_price`: the Dashboard now says 15.00. */
const PRODUCT_FROM_STRIPE = {
  id: 'prod_s1',
  object: 'product',
  active: true,
  name: 'S1',
  metadata: { turbopanel_tier: 'S1' },
  default_price: {
    id: 'price_s1', object: 'price', active: true, type: 'recurring', currency: 'usd', unit_amount: 1500,
    recurring: { interval: 'month', interval_count: 1 }, billing_scheme: 'per_unit', tax_behavior: 'exclusive', livemode: false,
  },
}

function stripeFetchDouble(calls: string[], subscriptionFromStripe: Record<string, unknown> = SUBSCRIPTION_FROM_STRIPE): StripeFetch {
  return (input) => {
    const url = new URL(input)
    calls.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/v1/subscriptions/sub_1') {
      return Promise.resolve(new Response(JSON.stringify(subscriptionFromStripe), { status: 200 }))
    }
    if (url.pathname === '/v1/invoices/in_1') {
      return Promise.resolve(new Response(JSON.stringify({ id: 'in_1', subscription: 'sub_1' }), { status: 200 }))
    }
    if (url.pathname === '/v1/products/prod_s1') {
      return Promise.resolve(new Response(JSON.stringify(PRODUCT_FROM_STRIPE), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'no' } }), { status: 404 }))
  }
}

type Harness = {
  app: Hono<AppEnv>
  trace: Trace
  db: StubDb
  scheduled: Array<() => Promise<void>>
  stripeCalls: string[]
}

async function buildApp(opts: {
  config?: BillingConfig | null
  claimed?: boolean
  viaRegisterWebhookRoutes?: boolean
  /**
   * Billing is hosted-only and `registerWebhookRoutes` mounts this gate on
   * Workers alone (pinned below). The leaf tests still run the gate under the
   * `deno` label because its Workers branch (`openTaskDb`) opens a real
   * Postgres client from `postgresConnectionString`, which a host-free test
   * cannot supply; the `deno` branch uses the injected `db` instead. The
   * runtime label changes only that and the trusted-IP header set.
   */
  runtime?: 'deno' | 'workers'
  licenses?: Record<string, unknown>[]
  subscriptionFromStripe?: Record<string, unknown>
} = {}): Promise<Harness> {
  const runtime = opts.runtime ?? 'deno'
  const trace: Trace = []
  const db = stubDb(trace, { claimed: opts.claimed, licenses: opts.licenses })
  const scheduled: Array<() => Promise<void>> = []
  const stripeCalls: string[] = []
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('runtime', runtime)
    c.set('db', db)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    const config = opts.config === undefined ? CONFIG : opts.config
    if (config) c.set('billingConfig', config)
    return next()
  })
  if (opts.viaRegisterWebhookRoutes) {
    registerWebhookRoutes(app, { runtime })
  } else {
    registerStripeWebhookRoutes(app, {
      runtime,
      rateLimiter: {
        limit: () => {
          trace.push('limiter')
          return Promise.resolve({ success: true })
        },
      },
      schedule: (task) => {
        trace.push('scheduled')
        scheduled.push(task)
      },
      createClient: (config) => createStripeClient(config, { fetch: stripeFetchDouble(stripeCalls, opts.subscriptionFromStripe) }),
    })
  }
  return { app, trace, db, scheduled, stripeCalls }
}

const NOW_SECONDS = Math.floor(Date.now() / 1000)

async function signedPost(
  body: string,
  opts: { secret?: string; timestamp?: number; header?: string | null } = {},
): Promise<Request> {
  const raw = new TextEncoder().encode(body)
  const t = opts.timestamp ?? NOW_SECONDS
  const header = opts.header === undefined
    ? `t=${t},v1=${await computeStripeSignature(raw, t, opts.secret ?? SIGNING_SECRET)}`
    : opts.header
  return new Request(`http://instance${STRIPE_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(header === null ? {} : { 'stripe-signature': header }),
    },
    body,
  })
}

function event(type: string, object: Record<string, unknown>, id = 'evt_1'): string {
  return JSON.stringify({ id, object: 'event', type, data: { object } })
}

test('billing off (no config) answers 503 stripe_webhook_not_configured, not 401', async () => {
  const h = await buildApp({ config: null })
  const res = await h.app.request(await signedPost(event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' })))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: STRIPE_WEBHOOK_NOT_CONFIGURED })
  assertEquals(h.trace.includes('insert:delivery'), false)
})

test('a key without a signing secret is also unconfigured — never an unverified accept', async () => {
  const h = await buildApp({ config: { ...CONFIG, webhookSigningSecret: null } })
  const res = await h.app.request(await signedPost(event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' })))
  assertEquals(res.status, 503)
  assertEquals(h.trace, ['limiter'])
})

test('a bad signature is 401 before any database write', async () => {
  const h = await buildApp()
  const body = event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' })
  for (const req of [
    await signedPost(body, { secret: 'whsec_wrong' }),
    await signedPost(body, { header: null }),
    await signedPost(body, { header: 'garbage' }),
    await signedPost(body, { timestamp: NOW_SECONDS - 3600 }),
  ]) {
    const res = await h.app.request(req)
    assertEquals(res.status, 401)
  }
  assertEquals(h.trace.filter((t) => t.startsWith('insert:')), [])
  assertEquals(h.scheduled.length, 0)
})

test('a signed body with no event id is 400', async () => {
  const h = await buildApp()
  const res = await h.app.request(await signedPost(JSON.stringify({ object: 'event', type: 'x' })))
  assertEquals(res.status, 400)
  assertEquals(h.trace.includes('insert:delivery'), false)
})

test('a duplicate event id answers 204 and schedules nothing', async () => {
  const h = await buildApp({ claimed: false })
  const res = await h.app.request(await signedPost(event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' })))
  assertEquals(res.status, 204)
  assertEquals(h.trace.at(-1), 'insert:delivery')
  assertEquals(h.scheduled.length, 0)
  // The claim carried the Stripe event id under the widened `stripe` kind.
  assertEquals(h.db.inserts[0]?.values.provider, 'stripe')
  assertEquals(h.db.inserts[0]?.values.externalDeliveryId, 'evt_1')
  assertEquals(h.db.inserts[0]?.values.event, 'customer.subscription.updated')
})

test('a valid delivery answers 200 immediately, without awaiting the projection', async () => {
  const h = await buildApp()
  const res = await h.app.request(await signedPost(event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' })))
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'customer.subscription.updated',
    result: { scheduled: true },
  })
  // Order: limiter → claim → schedule. Nothing from the projection has run.
  assertEquals(h.trace, ['limiter', 'insert:delivery', 'scheduled'])
  assertEquals(h.stripeCalls, [])
  assertEquals(h.scheduled.length, 1)

  // Now run the deferred task: it refetches from Stripe (never trusting the
  // payload) and writes payer → subscription → seat, then prunes.
  await h.scheduled[0]!()
  assertEquals(h.stripeCalls, [
    '/v1/subscriptions/sub_1?expand%5B0%5D=customer&expand%5B1%5D=customer.tax_ids',
  ])
  // The projection writes, then the entitlement sync takes and releases the lease.
  assertEquals(
    h.trace.slice(3),
    ['insert:payer', 'insert:subscription', 'delete:seat', 'insert:seat', 'insert:setting', 'delete:setting', 'delete:setting'],
  )
  const [, payerInsert, subInsert, seatInsert] = h.db.inserts
  assertEquals(payerInsert?.values.organizationId, ORG_ID)
  assertEquals(payerInsert?.values.providerCustomerId, 'cus_1')
  assertEquals(payerInsert?.values.taxId, 'DE123456789')
  assertEquals(subInsert?.values.providerSubscriptionId, 'sub_1')
  assertEquals(subInsert?.values.status, 'active')
  // `current_period_end` came from the item (basil API line).
  assertEquals(subInsert?.values.currentPeriodEnd, new Date(1_800_000_000 * 1000).toISOString())
  assertEquals(seatInsert?.values.tierId, TIER_ID)
  assertEquals(seatInsert?.values.quantity, 4)
  assertEquals(seatInsert?.values.providerItemId, 'si_1')
  // The seat carries the item's own price: what a mutation restates in `items[]`.
  assertEquals(seatInsert?.values.providerPriceId, 'price_s1')
})

test('an invoice event resolves its subscription and projects that', async () => {
  const h = await buildApp()
  const res = await h.app.request(await signedPost(event('invoice.payment_failed', { id: 'in_1', object: 'invoice' }, 'evt_2')))
  assertEquals(res.status, 200)
  await h.scheduled[0]!()
  assertEquals(h.stripeCalls[0], '/v1/invoices/in_1')
  assertEquals(h.stripeCalls[1]?.startsWith('/v1/subscriptions/sub_1'), true)
  assertEquals(h.trace.includes('insert:subscription'), true)
})

const LICENSE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

test('a subscription carrying a pending_update projects the OLD quantities — entitlement is raised by committed items only', async () => {
  const h = await buildApp({
    subscriptionFromStripe: {
      ...SUBSCRIPTION_FROM_STRIPE,
      // Stripe parked "5 seats" under pending_update; `items` still says 4.
      pending_update: { expires_at: 1_800_100_000, subscription_items: [{ id: 'si_1', quantity: 5, price: { id: 'price_s1' } }] },
    },
  })
  const res = await h.app.request(await signedPost(event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' }, 'evt_4')))
  assertEquals(res.status, 200)
  await h.scheduled[0]!()
  const seats = h.db.rows(subscriptionItem)
  assertEquals(seats.length, 1)
  assertEquals(seats[0]?.quantity, 4)
})

test('pending_update_applied lands the intent the committed items now show; pending_update_expired only reprojects and the intent survives', async () => {
  const licenses = [{ id: LICENSE_ID, organizationId: ORG_ID, serverId: null, name: null, token: 'x', revokedAt: null, createdAt: 'c', updatedAt: 'c' }]
  // One S1 seat given back at the boundary, written when the tier counted 4.
  const intent = () => newDeferredIntent('release-seat', { fromTierId: TIER_ID, toTierId: null, landsAt: null, fromQuantity: 4 })
  applied: {
    // The committed items now count 3: the release has landed.
    const h = await buildApp({
      licenses,
      subscriptionFromStripe: {
        ...SUBSCRIPTION_FROM_STRIPE,
        items: { object: 'list', has_more: false, data: [
          { id: 'si_1', object: 'subscription_item', quantity: 3, price: { id: 'price_s1', product: 'prod_s1' }, current_period_end: 1_800_000_000 },
        ] },
      },
    })
    await writePendingChanges(h.db, ORG_ID, withIntent(emptyLedger('sub_1'), intent()))

    const res = await h.app.request(await signedPost(event('customer.subscription.pending_update_applied', { id: 'sub_1', object: 'subscription' }, 'evt_5')))
    assertEquals(res.status, 200)
    await h.scheduled[0]!()
    assertEquals(h.db.rows(subscriptionItem).map((row) => row.quantity), [3])
    const { ledger } = await readPendingChanges(h.db, ORG_ID, 'sub_1')
    assertEquals(ledger.intents, [])
    // The unbound license is untouched: a license carries no tier to repoint.
    assertEquals(h.db.rows(license)[0]?.revokedAt, null)
    break applied
  }
  {
    // Items never changed (still 4) and the schedule still carries the phase:
    // nothing landed, nothing dropped — expiry is a plain reprojection.
    const h = await buildApp({
      licenses,
      subscriptionFromStripe: { ...SUBSCRIPTION_FROM_STRIPE, schedule: 'sub_sched_1' },
    })
    const written = intent()
    await writePendingChanges(h.db, ORG_ID, withIntent(emptyLedger('sub_1'), written))
    const res = await h.app.request(await signedPost(event('customer.subscription.pending_update_expired', { id: 'sub_1', object: 'subscription' }, 'evt_6')))
    assertEquals(res.status, 200)
    await h.scheduled[0]!()
    assertEquals(h.stripeCalls, ['/v1/subscriptions/sub_1?expand%5B0%5D=customer&expand%5B1%5D=customer.tax_ids'])
    assertEquals(h.db.rows(subscriptionItem).map((row) => row.quantity), [4])
    const { ledger } = await readPendingChanges(h.db, ORG_ID, 'sub_1')
    assertEquals(ledger.intents.map((i) => i.id), [written.id])
  }
})

test('the two catalogue events are projected: product.updated refreshes the tier cache through the same deferred task', async () => {
  assertEquals(PROJECTED_STRIPE_EVENT_TYPES.includes('product.updated'), true)
  assertEquals(PROJECTED_STRIPE_EVENT_TYPES.includes('price.updated'), true)
  const h = await buildApp()
  const res = await h.app.request(await signedPost(event('product.updated', { id: 'prod_s1', object: 'product' }, 'evt_7')))
  assertEquals(res.status, 200)
  assertEquals(h.trace, ['limiter', 'insert:delivery', 'scheduled'])
  await h.scheduled[0]!()
  assertEquals(h.stripeCalls, ['/v1/products/prod_s1?expand%5B0%5D=default_price'])
  assertEquals(h.db.rows(tier)[0]?.priceCents, 1500)
  assertEquals(h.db.rows(tier)[0]?.currency, 'usd')
  // No subscription was projected and no lease was taken.
  assertEquals(h.trace.filter((t) => t.startsWith('insert:')), ['insert:delivery'])
})

test('an unhandled event type is a logged no-op after the 200', async () => {
  const h = await buildApp()
  const res = await h.app.request(await signedPost(event('charge.refunded', { id: 'ch_1', object: 'charge' }, 'evt_3')))
  assertEquals(res.status, 200)
  await h.scheduled[0]!()
  assertEquals(h.stripeCalls, [])
  assertEquals(h.trace.filter((t) => t.startsWith('insert:')), ['insert:delivery'])
})

test('the body ceiling is enforced from the declared length', async () => {
  const h = await buildApp()
  const req = await signedPost('{}', { header: 'irrelevant' })
  const oversized = new Request(req, {
    headers: { ...Object.fromEntries(req.headers), 'content-length': String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1) },
  })
  const res = await h.app.request(oversized)
  assertEquals(res.status, 413)
})

test('registerWebhookRoutes mounts the Stripe kind on Workers; no :ref path exists', async () => {
  const h = await buildApp({ viaRegisterWebhookRoutes: true, config: null, runtime: 'workers' })
  const bare = await h.app.request(new Request(`http://instance${STRIPE_WEBHOOK_PATH}`, { method: 'POST', body: '{}' }))
  assertEquals(bare.status, 503)
  const scoped = await h.app.request(new Request(`http://instance${STRIPE_WEBHOOK_PATH}/some-ref`, { method: 'POST', body: '{}' }))
  assertEquals(scoped.status, 404)
})

test('registerWebhookRoutes does not mount the Stripe kind on Deno: self-hosted has no billing', async () => {
  // Even with a config on the context — the surface is absent, not 503.
  const h = await buildApp({ viaRegisterWebhookRoutes: true, runtime: 'deno' })
  const res = await h.app.request(new Request(`http://instance${STRIPE_WEBHOOK_PATH}`, { method: 'POST', body: '{}' }))
  assertEquals(res.status, 404)
  assertEquals(h.trace.includes('limiter'), false)
})

const TIER_S2 = '22222222-2222-4222-8222-222222222222'
const TIER_S2_ROW = { ...TIER_ROW, id: TIER_S2, label: 'S2', rank: 2, providerProductId: 'prod_s2' }

/** A projected org with one seat row on `sub_1`, before the two-item refetch lands. */
function projectedDb(): MemoryDb {
  const at = '2026-09-01T00:00:00.000Z'
  return createMemoryDb([
    [payer, [{ id: 'payer-1', provider: 'stripe', providerCustomerId: 'cus_1', organizationId: ORG_ID, userId: null, taxId: null, createdAt: at, updatedAt: at }]],
    [subscription, [{ id: 'sub-row', payerId: 'payer-1', providerSubscriptionId: 'sub_1', status: 'active', currentPeriodEnd: null, scheduleId: null, pastDueSince: null, graceExpiresAt: null, createdAt: at, updatedAt: at }]],
    [subscriptionItem, [{ id: 'seat-old', subscriptionId: 'sub-row', tierId: TIER_ID, providerItemId: 'si_old', providerPriceId: 'price_s1', quantity: 4, createdAt: at, updatedAt: at }]],
    [tier, [TIER_ROW, TIER_S2_ROW]],
    [license, []],
    [server, []],
    [setting, []],
  ])
}

const TWO_ITEM_SUBSCRIPTION = {
  ...SUBSCRIPTION_FROM_STRIPE,
  items: {
    object: 'list',
    has_more: false,
    data: [
      { id: 'si_1', object: 'subscription_item', quantity: 2, price: { id: 'price_s1', product: 'prod_s1' } },
      { id: 'si_2', object: 'subscription_item', quantity: 1, price: { id: 'price_s2', product: 'prod_s2' } },
    ],
  },
}

test('the projection writes payer, subscription and seats inside one transaction', async () => {
  const db = projectedDb()
  const client = createStripeClient(CONFIG, { fetch: stripeFetchDouble([], TWO_ITEM_SUBSCRIPTION) })
  const outcome = await projectSubscriptionById({ db, client, now: '2026-09-07T12:00:00.000Z' }, 'sub_1')
  assertEquals(outcome.action, 'projected')
  const seats = db.rows(subscriptionItem).map((row) => [row.providerItemId, row.tierId, row.providerPriceId, row.quantity])
  assertEquals(seats, [['si_1', TIER_ID, 'price_s1', 2], ['si_2', TIER_S2, 'price_s2', 1]])
  // Every projection write sits between `begin` and `commit`; nothing lands outside.
  const begin = db.ops.indexOf('begin')
  const commit = db.ops.indexOf('commit')
  assertEquals(begin >= 0 && commit > begin, true)
  assertEquals(db.ops.slice(0, begin).some((op) => /^(insert|update|delete):/.test(op)), false)
  assertEquals(db.ops.slice(begin, commit).includes('delete:seat'), true)
  assertEquals(db.ops.slice(begin, commit).filter((op) => op === 'insert:seat').length, 2)
})

test('a failure between the seat delete and the last seat insert rolls the whole projection back — no partial seat rows', async () => {
  const db = projectedDb()
  const before = db.rows(subscriptionItem).map((row) => ({ ...row }))
  const beforeSub = db.rows(subscription).map((row) => ({ ...row }))
  // Inject the failure on the second seat insert: the delete and the first
  // insert have already run, which is exactly the half-replaced state a
  // reader must never observe.
  const origInsert = db.insert.bind(db)
  let seatInserts = 0
  Object.assign(db, {
    insert: (table: unknown) => {
      const chain = origInsert(table as Parameters<typeof origInsert>[0])
      if (table !== subscriptionItem) return chain
      return {
        values: (values: Record<string, unknown>) => {
          seatInserts += 1
          if (seatInserts === 2) throw new Error('injected: seat insert failed')
          return chain.values(values)
        },
      }
    },
  })
  const client = createStripeClient(CONFIG, { fetch: stripeFetchDouble([], TWO_ITEM_SUBSCRIPTION) })
  let thrown: unknown
  try {
    await projectSubscriptionById({ db, client, now: '2026-09-07T12:00:00.000Z' }, 'sub_1')
  } catch (err) {
    thrown = err
  }
  assertEquals(thrown instanceof Error && thrown.message, 'injected: seat insert failed')
  assertEquals(seatInserts, 2)
  assertEquals(db.ops.includes('rollback'), true)
  // The seat rows are exactly what they were: neither the delete nor the
  // first insert survived the failed second insert.
  assertEquals(db.rows(subscriptionItem), before)
  // The subscription upsert in the same transaction was rolled back too.
  assertEquals(db.rows(subscription), beforeSub)
})

test('Workers without a connection string skip projection rather than racing the request client', async () => {
  const h = await buildApp({ runtime: 'workers' })
  const res = await h.app.request(
    await signedPost(event('customer.subscription.updated', { id: 'sub_1', object: 'subscription' })),
  )
  assertEquals(res.status, 200)
  assertEquals(await res.json(), {
    ok: true,
    event: 'customer.subscription.updated',
    result: { scheduled: false, skipped: 'database_unavailable' },
  })
  assertEquals(h.scheduled.length, 0)
})

test('a signed body that is not JSON is a bad request', async () => {
  const h = await buildApp()
  const res = await h.app.request(await signedPost('not-json'))
  assertEquals(res.status, 400)
  assertEquals(h.scheduled.length, 0)
})
