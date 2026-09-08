/**
 * The money boundary on the tier routes: billing off refuses, a price that
 * does not verify never becomes a row, a referenced row cannot have its
 * entitlements rewritten, and a duplicate label is a 409 rather than a
 * silent overwrite.
 *
 * The shape rules themselves are proven in
 * `tier-routes-helpers.hostfree.test.ts`; what is proven here is that the
 * route actually consults them, actually calls Stripe first, and actually
 * declines to write.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
} from '../client/authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../client/authn/crypto.ts'
import { deriveSecretsConfig } from '../client/authn/secrets.ts'
import type { BillingConfig } from '../lib/billing/config.ts'
import { StripeApiError } from '../lib/billing/errors.ts'
import { license, subscriptionItem, tier } from '../lib/db/schema.ts'
import type { TierRow } from '../lib/db/tier-records.ts'
import { createMemoryDb } from '../test-fixtures/memory-db.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { createStripeClientDouble, type StripeCall } from '../test-fixtures/stripe-client.ts'
import { registerAdminTierRoutes } from './tier-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const GIB = 1024 ** 3
const S3_ID = '33333333-3333-4333-8333-333333333333'
const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

const BILLING: BillingConfig = {
  secretKey: 'sk_test_x',
  webhookSigningSecret: 'whsec_x',
  apiVersion: '2025-08-27.basil',
}

function tierRow(overrides: Partial<TierRow> = {}): TierRow {
  return {
    id: S3_ID,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    generation: 1,
    rank: 3,
    label: 'S3',
    priceCents: 1000,
    providerPriceId: 'price_s3',
    isCustom: false,
    isActive: true,
    successorId: null,
    maxCores: 16,
    maxMemoryBytes: 64 * GIB,
    nicSlots: 5,
    driveSlots: 6,
    gpuSlots: 2,
    filesystemSlots: 9,
    ...overrides,
  } as TierRow
}

/** A Stripe Price that satisfies every check. */
function conformingPrice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'price_s3',
    active: true,
    type: 'recurring',
    currency: 'usd',
    unit_amount: 1000,
    recurring: { interval: 'month', interval_count: 1 },
    billing_scheme: 'per_unit',
    tax_behavior: 'exclusive',
    livemode: false,
    product: { id: 'prod_s3', name: 'TurboPanel S3 server seat', active: true },
    ...overrides,
  }
}

async function buildApp(opts: Readonly<{
  tiers?: TierRow[]
  licenses?: Record<string, unknown>[]
  seats?: Record<string, unknown>[]
  billing?: boolean
  respond?: (call: StripeCall) => unknown
}> = {}) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `root-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  // Session lookups fall through to the mock auth db; tier/license/seat are ours.
  const db = createMemoryDb(
    [
      [tier, opts.tiers ?? []],
      [license, opts.licenses ?? []],
      [subscriptionItem, opts.seats ?? []],
    ],
    { fallback: createMockAuthDb(state) },
  )
  const client = createStripeClientDouble(opts.respond ?? (() => conformingPrice()))

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    if (opts.billing !== false) c.set('billingConfig', BILLING)
    return next()
  })
  registerAdminTierRoutes(app, { secrets }, { createClient: () => client })

  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  return { app, cookie, db, client }
}

function post(app: Hono<AppEnv>, cookie: string, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function jsonBody<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

const CREATE_BODY = {
  generation: 1,
  label: 'S3',
  rank: 3,
  priceCents: 1000,
  providerPriceId: 'price_s3',
  isCustom: false,
  maxCores: 16,
  maxMemoryBytes: 64 * GIB,
  nicSlots: 5,
  driveSlots: 6,
  gpuSlots: 2,
  filesystemSlots: 9,
}

test('every tier route answers 503 when billing is off, before touching Stripe', async () => {
  const { app, cookie, client } = await buildApp({ billing: false })
  for (const [method, path] of [['GET', '/tiers'], ['GET', '/tiers/defaults']] as const) {
    const res = await app.request(path, { method, headers: { cookie } })
    assertEquals(res.status, 503)
    assertEquals((await jsonBody<{ error: string }>(res)).error, 'billing_not_configured')
  }
  const created = await post(app, cookie, '/tiers', CREATE_BODY)
  assertEquals(created.status, 503)
  // Nothing was asked of Stripe on the way to refusing.
  assertEquals(client.calls.length, 0)
})

test('a create verifies against Stripe first and writes nothing when the price does not conform', async () => {
  const { app, cookie, db, client } = await buildApp({
    respond: () => conformingPrice({ tax_behavior: 'unspecified', unit_amount: 500 }),
  })
  const res = await post(app, cookie, '/tiers', CREATE_BODY)
  assertEquals(res.status, 400)
  const body = await jsonBody<{
    error: string
    message: string
    verification: { ok: boolean }
  }>(res)
  assertEquals(body.error, 'price_verification_failed')
  // The reasons reach the operator: `message` is the field the console renders.
  assertEquals(body.message.includes('tax_behavior is unspecified'), true)
  assertEquals(body.message.includes('unit_amount 500 ≠ price_cents 1000'), true)
  assertEquals(body.verification.ok, false)
  // Verified before writing, and the write never happened.
  assertEquals(client.calls.map((call) => call.method), ['GET'])
  assertEquals(db.rows(tier).length, 0)
})

test('a conforming price is written, with the verification and any ladder warnings echoed', async () => {
  const { app, cookie, db, client } = await buildApp()
  const res = await post(app, cookie, '/tiers', CREATE_BODY)
  assertEquals(res.status, 201)
  const body = await jsonBody<{
    tier: { label: string; providerPriceId: string }
    verification: { ok: boolean }
    warnings: unknown[]
  }>(res)
  assertEquals(body.tier.label, 'S3')
  assertEquals(body.tier.providerPriceId, 'price_s3')
  assertEquals(body.verification.ok, true)
  assertEquals(body.warnings, [])
  assertEquals(db.rows(tier).length, 1)
  assertEquals(client.calls[0]?.path, '/v1/prices/price_s3')
})

test('a duplicate (generation, label) is a 409 and never an overwrite', async () => {
  const { app, cookie, db, client } = await buildApp({ tiers: [tierRow()] })
  const res = await post(app, cookie, '/tiers', { ...CREATE_BODY, maxCores: 999 })
  assertEquals(res.status, 409)
  const body = await jsonBody<{ error: string; message: string }>(res)
  assertEquals(body.error, 'tier_exists')
  assertEquals(body.message.includes('S3'), true)
  // The seed's upsert would have rewritten the row; this must not.
  assertEquals(db.rows<TierRow>(tier).length, 1)
  assertEquals(db.rows<TierRow>(tier)[0]?.maxCores, 16)
  // Refused before spending a Stripe call.
  assertEquals(client.calls.length, 0)
})

test('a referenced row refuses an entitlement patch with 409 and names the offending keys', async () => {
  const { app, cookie, db } = await buildApp({
    tiers: [tierRow()],
    licenses: [{ id: 'lic-1', organizationId: ORG, tierId: S3_ID, revokedAt: null, serverId: null }],
  })
  const res = await app.request(`/tiers/${S3_ID}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ nicSlots: 8, isActive: false }),
  })
  assertEquals(res.status, 409)
  const body = await jsonBody<{
    error: string
    forbidden: string[]
    references: { licenses: number; seats: number }
    message: string
  }>(res)
  assertEquals(body.error, 'tier_referenced')
  assertEquals(body.forbidden, ['nicSlots'])
  assertEquals(body.references, { licenses: 1, seats: 0 })
  assertEquals(body.message.includes('nicSlots'), true)
  // Nothing moved — not even the `isActive` half of the patch.
  assertEquals(db.rows<TierRow>(tier)[0]?.nicSlots, 5)
  assertEquals(db.rows<TierRow>(tier)[0]?.isActive, true)
})

test('a referenced row still accepts isActive, and a revoked licence still counts as a reference', async () => {
  const { app, cookie, db } = await buildApp({
    tiers: [tierRow()],
    licenses: [{
      id: 'lic-1',
      organizationId: ORG,
      tierId: S3_ID,
      revokedAt: '2026-09-01T00:00:00.000Z',
      serverId: null,
    }],
  })
  const res = await app.request(`/tiers/${S3_ID}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ isActive: false }),
  })
  assertEquals(res.status, 200)
  assertEquals(db.rows<TierRow>(tier)[0]?.isActive, false)
  const body = await jsonBody<{
    tier: { references: { licenses: number }; entitlementsEditable: boolean }
  }>(res)
  // The revoked licence is why the entitlements are reported as locked.
  assertEquals(body.tier.references.licenses, 1)
  assertEquals(body.tier.entitlementsEditable, false)
})

test('an unreferenced row may be patched freely, re-verifying only when the price moved', async () => {
  const { app, cookie, client } = await buildApp({ tiers: [tierRow()] })
  const slots = await app.request(`/tiers/${S3_ID}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ driveSlots: 8 }),
  })
  assertEquals(slots.status, 200)
  // The price did not move, so Stripe was not consulted.
  assertEquals(client.calls.length, 0)

  const priced = await app.request(`/tiers/${S3_ID}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ providerPriceId: 'price_other' }),
  })
  assertEquals(priced.status, 200)
  assertEquals(client.calls.map((call) => call.path), ['/v1/prices/price_other'])
})

test('deactivate never deletes, and refuses a successor that does not exist', async () => {
  const { app, cookie, db } = await buildApp({ tiers: [tierRow()] })
  const bad = await post(app, cookie, `/tiers/${S3_ID}/deactivate`, {
    successorId: '99999999-9999-4999-8999-999999999999',
  })
  assertEquals(bad.status, 400)

  const res = await post(app, cookie, `/tiers/${S3_ID}/deactivate`)
  assertEquals(res.status, 200)
  assertEquals(db.rows<TierRow>(tier).length, 1)
  assertEquals(db.rows<TierRow>(tier)[0]?.isActive, false)
})

test('a price id Stripe does not know is refused with our words, never Stripe\'s', async () => {
  const { app, cookie, db } = await buildApp({
    respond: () => {
      throw new StripeApiError({
        status: 404,
        type: 'invalid_request_error',
        // Stripe's own text, which must not reach the operator verbatim.
        message: 'No such price: price_nope',
        code: 'resource_missing',
      })
    },
  })
  const res = await post(app, cookie, '/tiers', CREATE_BODY)
  assertEquals(res.status, 400)
  const body = await jsonBody<{ error: string; status: number; message: string }>(res)
  assertEquals(body.error, 'price_lookup_failed')
  assertEquals(body.status, 404)
  assertEquals(body.message, 'Stripe has no price with that id on this key')
  assertEquals(JSON.stringify(body).includes('No such price'), false)
  assertEquals(db.rows(tier).length, 0)
})
