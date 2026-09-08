/**
 * Host-free coverage for the billing client surface: `503` without a key,
 * owner-only, `409` while the subscription is delinquent, `409` while the
 * quantity lease is held, and the Postgres-only reads.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import { emptyLedger, newDeferredIntent, withIntent } from '../../lib/billing/pending-changes.ts'
import type { OrganizationBillingState } from '../../lib/db/billing-records.ts'
import { tier } from '../../lib/db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { type BillingOrgView, summarizeTierSeats } from './routes-helpers.ts'
import { registerBillingRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S3 = '33333333-3333-4333-8333-333333333331'
const S5 = '55555555-5555-4555-8555-555555555555'
const NOW = '2026-09-07T12:00:00.000Z'
const CONFIG: BillingConfig = { secretKey: 'sk_test_x', webhookSigningSecret: null, apiVersion: '2025-08-27.basil' }

const tierRow = (id: string, label: string, rank: number) => ({
  id, label, generation: 1, rank, priceCents: 1000 * rank, providerPriceId: `price_${label}`, isCustom: false, isActive: true,
  successorId: null, maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1, createdAt: NOW, updatedAt: NOW,
})

function stateWith(status: string | null, seats: { tierId: string; label: string; quantity: number }[]): OrganizationBillingState {
  const payer = { id: 'p', organizationId: ORG, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: NOW, updatedAt: NOW }
  if (!status) return { payer, subscription: null, seats: [] }
  return {
    payer,
    subscription: { id: 's', payerId: 'p', providerSubscriptionId: 'sub_1', status, currentPeriodEnd: null, scheduleId: null, graceExpiresAt: null, pastDueSince: status === 'past_due' ? NOW : null, createdAt: NOW, updatedAt: NOW },
    seats: seats.map((seat, index) => ({
      seatId: `seat-${index}`,
      tierId: seat.tierId,
      providerItemId: `si_${index}`,
      quantity: seat.quantity,
      tier: { label: seat.label, generation: 1, rank: index, priceCents: 1000, providerPriceId: `price_${seat.label}`, isActive: true },
    })),
  }
}

type HarnessOpts = {
  config?: BillingConfig | null
  ownAllowed?: boolean
  view?: BillingOrgView
  leaseHeld?: boolean
}

async function buildApp(opts: HarnessOpts = {}) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const email = `billing-${crypto.randomUUID()}@example.com`
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, { sessionId: crypto.randomUUID(), userId, email, role: 'superadmin' })
  seedMockUser(state, { id: userId, email, isDisabled: false, isEmailVerified: true, role: 'superadmin' })
  state.organizations.push({ id: ORG, name: 'Billing Org' })
  const authDb = Object.assign(createMockAuthDb(state), {
    execute: () => Promise.resolve([{ allowed: opts.ownAllowed !== false }]),
  }) as unknown as Db
  const db = createMemoryDb([[tier, [tierRow(S3, 'S3', 3), tierRow(S5, 'S5', 5)]]], { fallback: authDb })
  const stripeCalls: string[] = []
  const leases: string[] = []
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    const config = opts.config === undefined ? CONFIG : opts.config
    if (config) c.set('billingConfig', config)
    return next()
  })
  // Billing is hosted-only; the aggregator never mounts this router on Deno.
  registerBillingRoutes(app, { secrets, runtime: 'workers', signupEnvOverride: undefined }, {
    createClient: () => {
      const trap = (path: string) => {
        stripeCalls.push(path)
        return Promise.reject(new Error(`unexpected stripe call ${path}`))
      }
      return { get: trap, post: trap, del: trap, listAll: trap } as never
    },
    loadView: () => Promise.resolve(opts.view ?? { state: stateWith('active', [{ tierId: S3, label: 'S3', quantity: 2 }]), counts: new Map(), ledger: emptyLedger('sub_1') }),
    beginMutation: () => {
      leases.push('begin')
      return Promise.resolve(opts.leaseHeld ? null : { organizationId: ORG, owner: 'me' })
    },
    endMutation: () => {
      leases.push('end')
      return Promise.resolve()
    },
    nowMs: () => Date.parse(NOW),
  })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const headers = { Cookie: cookie, [ORG_ID_HEADER]: ORG, 'content-type': 'application/json' }
  return { app, headers, stripeCalls, leases }
}

const PATHS = [
  ['GET', '/billing/catalog'],
  ['GET', '/billing/subscription'],
  ['POST', '/billing/checkout'],
  ['POST', '/billing/portal'],
  ['POST', '/billing/preview'],
  ['POST', '/billing/seats'],
  ['POST', '/billing/upgrade'],
  ['POST', '/billing/downgrade'],
] as const

test('every billing route is 401 without a session', async () => {
  const { app } = await buildApp()
  for (const [method, path] of PATHS) {
    const res = await app.request(path, { method })
    assertEquals(res.status, 401, `${method} ${path}`)
  }
})

test('every billing route is 503 billing_not_configured when the instance has no key — self-hosted has no billing surface', async () => {
  const { app, headers, stripeCalls } = await buildApp({ config: null })
  for (const [method, path] of PATHS) {
    const res = await app.request(path, { method, headers, body: method === 'POST' ? '{}' : undefined })
    assertEquals(res.status, 503, `${method} ${path}`)
    assertEquals(await res.json(), { error: 'billing_not_configured' })
  }
  assertEquals(stripeCalls, [])
})

test('billing routes are owner-only', async () => {
  const { app, headers } = await buildApp({ ownAllowed: false })
  const res = await app.request('/billing/catalog', { headers })
  assertEquals(res.status, 403)
})

test('GET /billing/catalog lists active tiers from Postgres in catalogue order, no Stripe call', async () => {
  const { app, headers, stripeCalls } = await buildApp()
  const res = await app.request('/billing/catalog', { headers })
  assertEquals(res.status, 200)
  const body = await res.json() as { tiers: { id: string; label: string; priceCents: number; entitlements: { maxCores: number } }[] }
  assertEquals(body.tiers.map((t) => [t.label, t.priceCents, t.entitlements.maxCores]), [['S3', 3000, 4], ['S5', 5000, 4]])
  assertEquals(stripeCalls, [])
})

test('GET /billing/subscription summarises the projection, with free seats net of outstanding releases', async () => {
  const view: BillingOrgView = {
    state: stateWith('past_due', [{ tierId: S3, label: 'S3', quantity: 3 }]),
    counts: new Map([[S3, { active: 1, bound: 1 }]]),
    ledger: withIntent(emptyLedger('sub_1'), newDeferredIntent('release-seat', { licenseId: null, fromTierId: S3, toTierId: null })),
  }
  assertEquals(summarizeTierSeats(view)[0]?.licensesFree, 1)
  const { app, headers, stripeCalls } = await buildApp({ view })
  const res = await app.request('/billing/subscription', { headers })
  assertEquals(res.status, 200)
  const body = await res.json() as { subscription: { status: string; pastDueSince: string | null; scheduleAttached: boolean }; tiers: Record<string, unknown>[]; pendingChanges: { kind: string }[] }
  assertEquals(body.subscription.status, 'past_due')
  assertEquals(body.subscription.pastDueSince, NOW)
  assertEquals(body.subscription.scheduleAttached, false)
  assertEquals(body.tiers, [{ tierId: S3, label: 'S3', seats: 3, licensesUsed: 1, licensesBound: 1, licensesFree: 1 }])
  assertEquals(body.pendingChanges.map((c) => c.kind), ['release-seat'])
  assertEquals(stripeCalls, [])
})

test('entitlement-raising routes answer 409 subscription_past_due while delinquent, before any Stripe call', async () => {
  const view: BillingOrgView = { state: stateWith('past_due', [{ tierId: S3, label: 'S3', quantity: 2 }]), counts: new Map(), ledger: emptyLedger('sub_1') }
  const { app, headers, stripeCalls } = await buildApp({ view })
  const preview = await app.request('/billing/preview', { method: 'POST', headers, body: JSON.stringify({ tierId: S3, delta: 1 }) })
  assertEquals(preview.status, 409)
  assertEquals((await preview.json() as { error: string }).error, 'subscription_past_due')
  const seats = await app.request('/billing/seats', { method: 'POST', headers, body: JSON.stringify({ tierId: S3, delta: 1 }) })
  assertEquals(seats.status, 409)
  assertEquals((await seats.json() as { error: string }).error, 'subscription_past_due')
  assertEquals(stripeCalls, [])
})

test('mutations answer 409 billing_mutation_in_progress while the lease is held; a held lease is never released by the loser', async () => {
  const view: BillingOrgView = { state: stateWith(null, []), counts: new Map(), ledger: emptyLedger('') }
  const { app, headers, leases, stripeCalls } = await buildApp({ leaseHeld: true, view })
  for (const [path, body] of [
    ['/billing/seats', { tierId: S3, delta: 1 }],
    ['/billing/checkout', { tierId: S3 }],
  ] as const) {
    const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
    assertEquals(res.status, 409, path)
    assertEquals(await res.json(), { error: 'billing_mutation_in_progress' })
  }
  assertEquals(leases, ['begin', 'begin'])
  assertEquals(stripeCalls, [])
})

test('a seat decrease below the licenses at the tier is refused with seats_in_use and releases the lease', async () => {
  const view: BillingOrgView = {
    state: stateWith('active', [{ tierId: S3, label: 'S3', quantity: 3 }]),
    counts: new Map([[S3, { active: 2, bound: 2 }]]),
    ledger: emptyLedger('sub_1'),
  }
  const { app, headers, leases, stripeCalls } = await buildApp({ view })
  const res = await app.request('/billing/seats', { method: 'POST', headers, body: JSON.stringify({ tierId: S3, delta: -2 }) })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'seats_in_use', tierId: S3, licensesFree: 1 })
  assertEquals(leases, ['begin', 'end'])
  assertEquals(stripeCalls, [])
})

test('checkout is refused once a live subscription is projected; malformed bodies are 400', async () => {
  const { app, headers } = await buildApp()
  const exists = await app.request('/billing/checkout', { method: 'POST', headers, body: JSON.stringify({ tierId: S3 }) })
  assertEquals(exists.status, 409)
  assertEquals(await exists.json(), { error: 'subscription_exists' })
  const bad = await app.request('/billing/upgrade', { method: 'POST', headers, body: '{"licenseId": 12}' })
  assertEquals(bad.status, 400)
  const notJson = await app.request('/billing/seats', { method: 'POST', headers, body: 'nope' })
  assertEquals(notJson.status, 400)
})

test('a downgrade to a tier that is not lower is refused before the lease is taken', async () => {
  const { app, headers, leases } = await buildApp()
  // No such active license: 404 before any tier comparison.
  const res = await app.request('/billing/downgrade', { method: 'POST', headers, body: JSON.stringify({ licenseId: '99999999-9999-4999-8999-999999999999', targetTierId: S3 }) })
  assertEquals(res.status, 404)
  assertEquals(leases, [])
})

test('POST /billing/portal is 404 for an organization with no projected payer, before any Stripe call', async () => {
  const view: BillingOrgView = { state: { payer: null, subscription: null, seats: [] }, counts: new Map(), ledger: emptyLedger('') }
  const { app, headers, stripeCalls } = await buildApp({ view })
  const res = await app.request('/billing/portal', { method: 'POST', headers })
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: 'Not found' })
  assertEquals(stripeCalls, [])
})
