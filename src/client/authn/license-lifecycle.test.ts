import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import { emptyLedger, newDeferredIntent, readPendingChanges, withIntent, writePendingChanges } from '../../lib/billing/pending-changes.ts'
import { BILLING_QUANTITY_LEASE_MS, billingQuantityLockKey } from '../../lib/billing/quantity-lock.ts'
import { license, payer, setting, subscription, subscriptionItem, tier } from '../../lib/db/schema.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import { createStripeClientDouble, formOf, type StripeCall, type StripeClientDouble } from '../../test-fixtures/stripe-client.ts'
import { assertLicenseInvalidationAllowed } from './license-lifecycle.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

/** A db that throws on any use: the self-hosted gate must not touch it. */
const untouchableDb = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`db.${String(prop)} used with billing off`)
  },
}) as unknown as Db

async function gate(runtime: 'deno' | 'workers', tierId: string | null): Promise<number | null> {
  const app = new Hono<AppEnv>()
  app.get('/x', async (c) => {
    const denied = await assertLicenseInvalidationAllowed(c, {
      db: untouchableDb,
      runtime,
      organizationId: ORG_ID,
      licenseId: '00000000-0000-4000-8000-000000000001',
      tierId,
      billingConfig: undefined,
    })
    return denied ?? c.json({ ok: true })
  })
  const res = await app.request('/x')
  return res.status === 200 ? null : res.status
}

test('assertLicenseInvalidationAllowed always allows on deno when billing is off', async () => {
  assertEquals(await gate('deno', '11111111-1111-4111-8111-111111111111'), null)
})

test('assertLicenseInvalidationAllowed always allows on workers when billing is off', async () => {
  assertEquals(await gate('workers', null), null)
})

// ---------------------------------------------------------------------------
// T11 · the gate with billing ON: the release-seat intent and the schedule.
// ---------------------------------------------------------------------------

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const LIC = '00000000-0000-4000-8000-000000000001'
const NOW = '2026-09-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const CONFIG: BillingConfig = { secretKey: 'sk_test_x', webhookSigningSecret: null, apiVersion: '2025-08-27.basil' }
const PERIOD_START = 1_700_000_000
const PERIOD_END = 1_702_592_000

const tierRow = (id: string, label: string, rank: number) => ({
  id, label, generation: 1, rank, priceCents: 1000 * rank, providerPriceId: `price_${label}`, isCustom: false, isActive: true,
  successorId: null, maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1, createdAt: NOW, updatedAt: NOW,
})

function hostedDb(opts: { seats: number; status?: string; scheduleId?: string | null } = { seats: 2 }): MemoryDb {
  return createMemoryDb([
    [setting, []],
    [tier, [tierRow(S1, 'S1', 1), tierRow(S2, 'S2', 2)]],
    [payer, [{ id: 'payer-1', provider: 'stripe', providerCustomerId: 'cus_1', organizationId: ORG_ID, userId: null, taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{
      id: 'sub-row', payerId: 'payer-1', providerSubscriptionId: 'sub_1', status: opts.status ?? 'active',
      currentPeriodEnd: null, scheduleId: opts.scheduleId ?? null, pastDueSince: null, graceExpiresAt: null, createdAt: NOW, updatedAt: NOW,
    }]],
    [subscriptionItem, opts.seats > 0 ? [{ id: 'seat-1', subscriptionId: 'sub-row', tierId: S1, providerItemId: 'si_1', quantity: opts.seats, createdAt: NOW, updatedAt: NOW }] : []],
    [license, [{ id: LIC, organizationId: ORG_ID, serverId: null, tierId: S1, name: null, token: 'x', revokedAt: null, createdAt: NOW, updatedAt: NOW }]],
  ])
}

function scheduleObject(currentItems: { price: string; quantity: number }[]) {
  return { id: 'sub_sched_1', object: 'subscription_schedule', status: 'active', subscription: 'sub_1', phases: [{ start_date: PERIOD_START, end_date: PERIOD_END, items: currentItems }] }
}

type Route = `${StripeCall['method']} ${string}`

function routedClient(routes: Partial<Record<Route, (call: StripeCall) => unknown>>): StripeClientDouble {
  return createStripeClientDouble((call) => {
    const handler = routes[`${call.method} ${call.path}` as Route]
    if (!handler) throw new Error(`unexpected Stripe call ${call.method} ${call.path}`)
    return handler(call)
  })
}

/** Run the gate through a real Hono context; `null` is "allowed", a status is a refusal. */
async function hostedGate(db: Db, client: StripeClientDouble | null, opts: { tierId?: string | null } = {}) {
  let clientRequests = 0
  let refusal: { status: number; body: unknown } | null = null
  const app = new Hono<AppEnv>()
  app.get('/x', async (c) => {
    const denied = await assertLicenseInvalidationAllowed(c, {
      db,
      runtime: 'workers',
      organizationId: ORG_ID,
      licenseId: LIC,
      tierId: opts.tierId === undefined ? S1 : opts.tierId,
      billingConfig: CONFIG,
      createClient: () => {
        clientRequests += 1
        if (!client) throw new Error('createClient called when no Stripe call was expected')
        return client
      },
      nowMs: NOW_MS,
    })
    if (denied) {
      refusal = { status: denied.status, body: await denied.clone().json() }
      return denied
    }
    return c.json({ ok: true })
  })
  await app.request('/x')
  return { refusal: refusal as { status: number; body: unknown } | null, clientRequests }
}

const ledgerOf = async (db: Db) => (await readPendingChanges(db, ORG_ID, 'sub_1', NOW_MS)).ledger
const lockRow = (db: MemoryDb) => db.rows(setting).find((row) => row.key === billingQuantityLockKey(ORG_ID)) ?? null

test('T11 · a revoke records a release-seat intent naming the license and writes the schedule phase at the reduced quantity; the lease is released', async () => {
  const db = hostedDb({ seats: 2 })
  const client = routedClient({
    'POST /v1/subscription_schedules': () => scheduleObject([{ price: 'price_S1', quantity: 2 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => scheduleObject([{ price: 'price_S1', quantity: 2 }]),
  })
  const { refusal } = await hostedGate(db, client)
  assertEquals(refusal, null)

  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.length, 1)
  const intent = ledger.intents[0]!
  assertEquals(intent.kind, 'release-seat')
  assertEquals(intent.licenseId, LIC)
  assertEquals(intent.fromTierId, S1)
  assertEquals(intent.toTierId, null)

  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['POST /v1/subscription_schedules', 'POST /v1/subscription_schedules/sub_sched_1'])
  const [create, phases] = client.calls as [StripeCall, StripeCall]
  assertEquals(formOf(create, 'from_subscription'), 'sub_1')
  assertEquals(create.idempotencyKey, `${intent.idempotencyKey}:schedule`)
  assertEquals(phases.idempotencyKey, `${intent.idempotencyKey}:phases`)
  assertEquals(formOf(phases, 'phases[1][items][0][price]'), 'price_S1')
  assertEquals(formOf(phases, 'phases[1][items][0][quantity]'), '1')
  // Nothing local moved: the seat row is the provider's count until the boundary.
  assertEquals(db.rows(subscriptionItem)[0]?.quantity, 2)
  assertEquals(lockRow(db), null)
})

test('T11 · an attached schedule is read and rewritten rather than created', async () => {
  const db = hostedDb({ seats: 2, scheduleId: 'sub_sched_1' })
  const client = routedClient({
    'GET /v1/subscription_schedules/sub_sched_1': () => scheduleObject([{ price: 'price_S1', quantity: 2 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => scheduleObject([{ price: 'price_S1', quantity: 2 }]),
  })
  const { refusal } = await hostedGate(db, client)
  assertEquals(refusal, null)
  assertEquals(client.calls.map((c) => `${c.method} ${c.path}`), ['GET /v1/subscription_schedules/sub_sched_1', 'POST /v1/subscription_schedules/sub_sched_1'])
})

test('T11 · the intent is written before the Stripe call: a Stripe failure keeps it and still allows the revoke', async () => {
  const db = hostedDb({ seats: 2 })
  const client = routedClient({
    'POST /v1/subscription_schedules': () => {
      throw new StripeApiError({ status: 503, type: 'api_error', message: 'try again' })
    },
  })
  const { refusal } = await hostedGate(db, client)
  assertEquals(refusal, null)
  const ledger = await ledgerOf(db)
  assertEquals(ledger.intents.map((i) => [i.kind, i.licenseId]), [['release-seat', LIC]])
  assertEquals(client.calls.length, 1)
  assertEquals(lockRow(db), null)
})

test('T11 · a held quantity lease refuses with 409 billing_mutation_in_progress, writes no intent and calls nothing', async () => {
  const db = hostedDb({ seats: 2 })
  db.rows(setting).push({
    key: billingQuantityLockKey(ORG_ID),
    value: { owner: 'someone-else', expiresAt: new Date(NOW_MS + BILLING_QUANTITY_LEASE_MS).toISOString() },
    createdAt: NOW,
    updatedAt: NOW,
  })
  const { refusal, clientRequests } = await hostedGate(db, null)
  assertEquals(refusal, { status: 409, body: { error: 'billing_mutation_in_progress' } })
  assertEquals((await ledgerOf(db)).intents, [])
  assertEquals(clientRequests, 0)
  assertEquals(lockRow(db)?.value, { owner: 'someone-else', expiresAt: new Date(NOW_MS + BILLING_QUANTITY_LEASE_MS).toISOString() })
})

test('T11 · an ended subscription has no seat to give back: allowed, no intent, no Stripe call, lease released', async () => {
  const db = hostedDb({ seats: 2, status: 'canceled' })
  const { refusal, clientRequests } = await hostedGate(db, null)
  assertEquals(refusal, null)
  assertEquals((await ledgerOf(db)).intents, [])
  assertEquals(clientRequests, 0)
  assertEquals(lockRow(db), null)
})

test('T11 · a release already recorded for the license is not duplicated; a parked downgrade on it is replaced by the release', async () => {
  const already = hostedDb({ seats: 2 })
  const existing = newDeferredIntent('release-seat', { licenseId: LIC, fromTierId: S1, toTierId: null, nowMs: NOW_MS })
  await writePendingChanges(already, ORG_ID, withIntent(emptyLedger('sub_1'), existing), NOW_MS)
  const first = await hostedGate(already, null)
  assertEquals(first.refusal, null)
  assertEquals(first.clientRequests, 0)
  assertEquals((await ledgerOf(already)).intents.map((i) => i.id), [existing.id])

  const parked = hostedDb({ seats: 2 })
  const downgrade = newDeferredIntent('downgrade', { licenseId: LIC, fromTierId: S1, toTierId: S2, nowMs: NOW_MS })
  await writePendingChanges(parked, ORG_ID, withIntent(emptyLedger('sub_1'), downgrade), NOW_MS)
  const client = routedClient({
    'POST /v1/subscription_schedules': () => scheduleObject([{ price: 'price_S1', quantity: 2 }]),
    'POST /v1/subscription_schedules/sub_sched_1': () => scheduleObject([{ price: 'price_S1', quantity: 2 }]),
  })
  const second = await hostedGate(parked, client)
  assertEquals(second.refusal, null)
  const intents = (await ledgerOf(parked)).intents
  assertEquals(intents.map((i) => [i.kind, i.licenseId]), [['release-seat', LIC]])
  assertEquals(intents[0]!.id === downgrade.id, false)
})

test('T11 · billing on but a tierless license (minted before billing) releases nothing and reads nothing', async () => {
  const { refusal, clientRequests } = await hostedGate(untouchableDb, null, { tierId: null })
  assertEquals(refusal, null)
  assertEquals(clientRequests, 0)
})

test('T11 · releasing the organization\'s last seat schedules a cancel at the period end instead of an empty phase', async () => {
  const db = hostedDb({ seats: 1 })
  const client = routedClient({
    'POST /v1/subscription_schedules': () => scheduleObject([{ price: 'price_S1', quantity: 1 }]),
    'POST /v1/subscription_schedules/sub_sched_1': (call) => {
      // What the real API answers to a phase with no items.
      if (formOf(call, 'phases[1][start_date]') !== undefined && formOf(call, 'phases[1][items][0][price]') === undefined) {
        throw new StripeApiError({ status: 400, type: 'invalid_request_error', message: 'You must specify at least one item' })
      }
      return scheduleObject([{ price: 'price_S1', quantity: 1 }])
    },
  })
  const { refusal, clientRequests } = await hostedGate(db, client)
  assertEquals(refusal, null)
  assertEquals(clientRequests, 1)
  const phases = client.calls[1]!
  // Paid-for until the boundary, then the subscription ends: the current
  // phase alone, cancel when it completes, no future phase at all.
  assertEquals(formOf(phases, 'phases[0][end_date]'), String(PERIOD_END))
  assertEquals(formOf(phases, 'phases[0][items][0][price]'), 'price_S1')
  assertEquals(formOf(phases, 'phases[1][start_date]'), undefined)
  assertEquals(formOf(phases, 'end_behavior'), 'cancel')
  // The revoke goes through and the release stays recorded until the
  // boundary consumes it (or a re-subscribe clears the ledger).
  assertEquals((await ledgerOf(db)).intents.map((i) => i.kind), ['release-seat'])
  assertEquals(lockRow(db), null)
})
