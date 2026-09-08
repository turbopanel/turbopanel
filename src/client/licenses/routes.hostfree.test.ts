/**
 * Host-free coverage for the hosted license mint (ledger T9): with billing
 * on, a key is minted only against a free seat at a purchasable tier, read
 * under the organization's quantity lease — and the lease is released on
 * every exit. Self-hosted (no billing config) mints with no tier and
 * touches none of it.
 */

import { assertEquals, assertExists } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { BillingConfig } from '../../lib/billing/config.ts'
import { emptyLedger, newDeferredIntent, withIntent, writePendingChanges } from '../../lib/billing/pending-changes.ts'
import { BILLING_QUANTITY_LEASE_MS, billingQuantityLockKey } from '../../lib/billing/quantity-lock.ts'
import { license, payer, server, setting, subscription, subscriptionItem, tier } from '../../lib/db/schema.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
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
import { registerLicenseRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '33333333-3333-4333-8333-333333333333'
const S3 = '33333333-3333-4333-8333-333333333331'
const S_INACTIVE = '33333333-3333-4333-8333-333333333332'
const S_NO_PRICE = '33333333-3333-4333-8333-333333333334'
const S_UNKNOWN = '33333333-3333-4333-8333-333333333339'
const NOW = '2026-09-07T12:00:00.000Z'
const CONFIG: BillingConfig = { secretKey: 'sk_test_x', webhookSigningSecret: null, apiVersion: '2025-08-27.basil' }

const tierRow = (id: string, label: string, rank: number, extra: Record<string, unknown> = {}) => ({
  id, label, generation: 1, rank, priceCents: 1000 * rank, providerPriceId: `price_${label}`, isCustom: false, isActive: true,
  successorId: null, maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1, createdAt: NOW, updatedAt: NOW,
  ...extra,
})

type Fixture = {
  /** S3 seats on the projected subscription; `null` for no subscription at all. */
  seats?: number | null
  licenses?: { id: string; tierId: string; revokedAt?: string | null }[]
  config?: BillingConfig | null
}

async function buildApp(fx: Fixture = {}) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const email = `licenses-${crypto.randomUUID()}@example.com`
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, { sessionId: crypto.randomUUID(), userId, email, role: 'superadmin' })
  seedMockUser(state, { id: userId, email, isDisabled: false, isEmailVerified: true, role: 'superadmin' })
  state.organizations.push({ id: ORG, name: 'License Org' })
  const authDb = Object.assign(createMockAuthDb(state), {
    execute: () => Promise.resolve([{ allowed: true }]),
  }) as unknown as Db

  const seats = fx.seats === undefined ? 2 : fx.seats
  const db = createMemoryDb([
    [setting, []],
    [server, []],
    [tier, [
      tierRow(S3, 'S3', 3),
      tierRow(S_INACTIVE, 'S4', 4, { isActive: false }),
      tierRow(S_NO_PRICE, 'SX', 9, { providerPriceId: null, priceCents: null, isCustom: true }),
    ]],
    [payer, seats === null ? [] : [{ id: 'payer-1', provider: 'stripe', providerCustomerId: 'cus_1', organizationId: ORG, userId: null, taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, seats === null ? [] : [{
      id: 'sub-row', payerId: 'payer-1', providerSubscriptionId: 'sub_1', status: 'active',
      currentPeriodEnd: null, scheduleId: null, pastDueSince: null, graceExpiresAt: null, createdAt: NOW, updatedAt: NOW,
    }]],
    [subscriptionItem, seats ? [{ id: 'seat-3', subscriptionId: 'sub-row', tierId: S3, providerItemId: 'si_3', quantity: seats, createdAt: NOW, updatedAt: NOW }] : []],
    [license, (fx.licenses ?? []).map((row) => ({
      id: row.id, organizationId: ORG, serverId: null, tierId: row.tierId, name: null, token: 'hashed',
      revokedAt: row.revokedAt ?? null, createdAt: NOW, updatedAt: NOW,
    }))],
  ], { fallback: authDb })

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    const config = fx.config === undefined ? CONFIG : fx.config
    if (config) c.set('billingConfig', config)
    return next()
  })
  registerLicenseRoutes(app, { secrets, runtime: 'workers', signupEnvOverride: undefined, baseUrl: 'https://panel.example.com' })
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  const headers = { Cookie: cookie, [ORG_ID_HEADER]: ORG, 'content-type': 'application/json' }
  return { app, headers, db }
}

function mint(app: Hono<AppEnv>, headers: Record<string, string>, body: Record<string, unknown>) {
  return app.request('/licenses', { method: 'POST', headers, body: JSON.stringify(body) })
}

function lockRow(db: MemoryDb) {
  return db.rows(setting).find((row) => row.key === billingQuantityLockKey(ORG)) ?? null
}

const L_ACTIVE = '44444444-4444-4444-8444-444444444441'
const L_REVOKED = '44444444-4444-4444-8444-444444444442'

test('T9 · with billing on a tier is required, and it must be purchasable: inactive, unpriced and unknown tiers are 400 before the lease', async () => {
  const { app, headers, db } = await buildApp()
  const missing = await mint(app, headers, {})
  assertEquals(missing.status, 400)
  assertEquals(await missing.json(), { error: 'tier_required' })
  for (const [tierId, reason] of [[S_INACTIVE, 'inactive'], [S_NO_PRICE, 'uncatalogued'], [S_UNKNOWN, 'not_found']]) {
    const res = await mint(app, headers, { tierId })
    assertEquals(res.status, 400, reason)
    assertEquals(await res.json(), { error: 'tier_not_purchasable', reason })
  }
  assertEquals(lockRow(db), null)
  assertEquals(db.rows(license), [])
})

test('T9 · no free seat at the tier is 409 no_free_seat with the counts; the lease was taken and is released', async () => {
  const { app, headers, db } = await buildApp({ seats: 1, licenses: [{ id: L_ACTIVE, tierId: S3 }] })
  const res = await mint(app, headers, { tierId: S3 })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'no_free_seat', tierId: S3, seats: 1, licensesUsed: 1, licensesFree: 0 })
  assertEquals(db.rows(license).length, 1)
  assertEquals(lockRow(db), null)

  // A purchasable tier with no seat row at all reads as zero of everything.
  const none = await buildApp({ seats: null })
  const noSeats = await mint(none.app, none.headers, { tierId: S3 })
  assertEquals(noSeats.status, 409)
  assertEquals(await noSeats.json(), { error: 'no_free_seat', tierId: S3, seats: 0, licensesUsed: 0, licensesFree: 0 })
  assertEquals(lockRow(none.db), null)
})

test('T9 · a free seat mints a key at that tier, once, and the lease is released', async () => {
  const { app, headers, db } = await buildApp({ seats: 2, licenses: [{ id: L_ACTIVE, tierId: S3 }] })
  const res = await mint(app, headers, { tierId: S3, name: 'edge-1' })
  assertEquals(res.status, 200)
  const body = await res.json() as { licenseId: string; licenseToken: string; installCommand: string }
  assertExists(body.licenseId)
  assertExists(body.licenseToken)
  assertEquals(typeof body.installCommand, 'string')
  const minted = db.rows(license).find((row) => row.id === body.licenseId)
  assertEquals(minted?.tierId, S3)
  assertEquals(minted?.name, 'edge-1')
  assertEquals(lockRow(db), null)

  // The seat is now taken: the next mint at the tier is refused.
  const again = await mint(app, headers, { tierId: S3 })
  assertEquals(again.status, 409)
  assertEquals((await again.json() as { error: string }).error, 'no_free_seat')
  assertEquals(db.rows(license).length, 2)
})

test('T9 · a revoked license does not hold a seat', async () => {
  const { app, headers, db } = await buildApp({ seats: 1, licenses: [{ id: L_REVOKED, tierId: S3, revokedAt: NOW }] })
  const res = await mint(app, headers, { tierId: S3 })
  assertEquals(res.status, 200)
  assertEquals(db.rows(license).filter((row) => row.revokedAt === null).length, 1)
})

test('T9 · an outstanding release-seat intent still counts against the tier until the boundary lands', async () => {
  const { app, headers, db } = await buildApp({ seats: 2, licenses: [{ id: L_ACTIVE, tierId: S3 }] })
  const release = newDeferredIntent('release-seat', { licenseId: null, fromTierId: S3, toTierId: null, nowMs: Date.parse(NOW) })
  await writePendingChanges(db, ORG, withIntent(emptyLedger('sub_1'), release), Date.parse(NOW))
  const res = await mint(app, headers, { tierId: S3 })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'no_free_seat', tierId: S3, seats: 2, licensesUsed: 1, licensesFree: 0 })
})

test('T9 · while another holder has the quantity lease the mint is 409 billing_mutation_in_progress and nothing is written', async () => {
  const { app, headers, db } = await buildApp({ seats: 2 })
  // The route reads the real clock, so the foreign lease must be live now.
  db.rows(setting).push({
    key: billingQuantityLockKey(ORG),
    value: { owner: 'someone-else', expiresAt: new Date(Date.now() + BILLING_QUANTITY_LEASE_MS).toISOString() },
    createdAt: NOW,
    updatedAt: NOW,
  })
  const res = await mint(app, headers, { tierId: S3 })
  assertEquals(res.status, 409)
  assertEquals(await res.json(), { error: 'billing_mutation_in_progress' })
  assertEquals(db.rows(license), [])
  // The loser never releases a lease it does not own.
  assertEquals(lockRow(db)?.value, { owner: 'someone-else', expiresAt: (lockRow(db)?.value as { expiresAt: string }).expiresAt })
})

test('T9 · with billing off a tier in the body is ignored: the key is minted with no tier and no lease is ever taken', async () => {
  const { app, headers, db } = await buildApp({ config: null, seats: null })
  const res = await mint(app, headers, { tierId: S3 })
  assertEquals(res.status, 200)
  const body = await res.json() as { licenseId: string }
  assertEquals(db.rows(license).find((row) => row.id === body.licenseId)?.tierId, null)
  assertEquals(db.rows(setting), [])
})
