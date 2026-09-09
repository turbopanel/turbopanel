/**
 * Entitlement sync: landed intents are dropped, the assignment follows the
 * committed seats, an ended subscription revokes every license and clears
 * every assignment, and a held lease makes the sync yield to the holder.
 */

import { assertEquals } from '@std/assert'
import { isNull } from 'drizzle-orm'
import { license, payer, server, setting, subscription, subscriptionItem, tier } from '../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { syncEntitlementsForOrganization } from './entitlements.ts'
import {
  billingPendingChangesKey,
  newDeferredIntent,
  PENDING_CHANGES_LEDGER_VERSION,
  readPendingChanges,
} from './pending-changes.ts'
import { tryBeginQuantityMutation } from './quantity-lock.ts'

const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S1 = '11111111-1111-4111-8111-111111111111'
const S3 = '33333333-3333-4333-8333-333333333333'
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NOW = '2026-09-07T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const GIB = 1024 ** 3

const tierRow = (id: string, label: string, rank: number) => ({
  id, createdAt: NOW, updatedAt: NOW, label, rank, provider: 'stripe', providerProductId: `prod_${label}`,
  priceCents: 1000 * rank, currency: 'usd', isCustom: false, isActive: true,
})
const hardware = (cores: number) => ({ resources: { cpus: [{ cores: { total: cores } }], memory: { totalBytes: 8 * GIB } } })

function seed(opts: {
  seats: { tierId: string; quantity: number }[]
  status?: string
  currentPeriodEnd?: string | null
  ledger?: unknown
}) {
  return createMemoryDb([
    [tier, [tierRow(S1, 'S1', 1), tierRow(S3, 'S3', 3)]],
    [payer, [{ id: PAYER, organizationId: ORG, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{
      id: SUB, payerId: PAYER, providerSubscriptionId: 'sub_1', status: opts.status ?? 'active',
      currentPeriodEnd: opts.currentPeriodEnd ?? '2026-10-01T00:00:00.000Z', scheduleId: null,
      graceExpiresAt: null, pastDueSince: null, createdAt: NOW, updatedAt: NOW,
    }]],
    [subscriptionItem, opts.seats.map((seat, index) => ({
      id: `seat-${index}`, subscriptionId: SUB, tierId: seat.tierId, providerItemId: `si_${index}`,
      providerPriceId: `price_${index}`, quantity: seat.quantity, createdAt: NOW, updatedAt: NOW,
    }))],
    [server, [
      { id: SERVER_A, organizationId: ORG, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: NOW, metadata: hardware(2), assignedTierId: null },
      { id: SERVER_B, organizationId: ORG, createdAt: '2026-09-02T00:00:00.000Z', updatedAt: NOW, metadata: hardware(12), assignedTierId: S1 },
    ]],
    [license, [
      { id: 'l-a', organizationId: ORG, serverId: SERVER_A, name: null, token: 'x', revokedAt: null, createdAt: NOW, updatedAt: NOW },
      { id: 'l-b', organizationId: ORG, serverId: SERVER_B, name: null, token: 'x', revokedAt: null, createdAt: NOW, updatedAt: NOW },
      { id: 'l-free', organizationId: ORG, serverId: null, name: null, token: 'x', revokedAt: null, createdAt: NOW, updatedAt: NOW },
    ]],
    [setting, opts.ledger
      ? [{ id: 'set-1', key: billingPendingChangesKey(ORG), value: opts.ledger, createdAt: NOW, updatedAt: NOW }]
      : []],
  ])
}

async function assignments(db: ReturnType<typeof seed>) {
  const rows = await db.select({ id: server.id, assignedTierId: server.assignedTierId }).from(server)
  return Object.fromEntries(rows.map((row) => [row.id, row.assignedTierId]))
}

test('a live subscription: the assignment follows the committed seats and a stale row moves', async () => {
  const db = seed({ seats: [{ tierId: S1, quantity: 1 }, { tierId: S3, quantity: 1 }] })
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false },
  )
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  // A (2 cores) takes S1, B (12 cores) needs S3 — B was cached on S1 and moves.
  assertEquals(await assignments(db), { [SERVER_A]: S1, [SERVER_B]: S3 })
  assertEquals([...outcome.result.assignment.changed].sort(), [SERVER_A, SERVER_B].sort())
  assertEquals(outcome.result.assignment.uncovered, [])
  assertEquals(outcome.result.revokedLicenseIds, [])
  assertEquals(outcome.scheduleRebuilt, false)
})

test('a landed intent is dropped from the ledger; an outstanding one survives', async () => {
  const landed = newDeferredIntent('release-seat', { fromTierId: S3, toTierId: null, landsAt: '2026-09-01T00:00:00.000Z', fromQuantity: 2, nowMs: NOW_MS })
  const parked = newDeferredIntent('release-seat', { fromTierId: S1, toTierId: null, landsAt: '2026-10-01T00:00:00.000Z', fromQuantity: 1, nowMs: NOW_MS })
  const db = seed({
    seats: [{ tierId: S1, quantity: 1 }, { tierId: S3, quantity: 1 }],
    ledger: { version: PENDING_CHANGES_LEDGER_VERSION, providerSubscriptionId: 'sub_1', intents: [landed, parked] },
  })
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false },
  )
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  assertEquals(outcome.result.landedIntentIds, [landed.id])
  const { ledger } = await readPendingChanges(db, ORG, 'sub_1')
  assertEquals(ledger.intents.map((intent) => intent.id), [parked.id])
})

test('an ended subscription revokes every license, bound ones included, and clears every assignment', async () => {
  const db = seed({ seats: [{ tierId: S1, quantity: 1 }, { tierId: S3, quantity: 1 }], status: 'canceled' })
  const disconnected: string[] = []
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS, onRevokeBound: (serverId) => { disconnected.push(serverId); return Promise.resolve() } },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false },
  )
  assertEquals(outcome.action, 'synced')
  if (outcome.action !== 'synced') return
  assertEquals(outcome.result.revokedLicenseIds.sort(), ['l-a', 'l-b', 'l-free'])
  assertEquals(outcome.result.disconnectedServerIds.sort(), [SERVER_A, SERVER_B])
  assertEquals(disconnected.sort(), [SERVER_A, SERVER_B])
  assertEquals(await assignments(db), { [SERVER_A]: null, [SERVER_B]: null })
  const active = await db.select({ id: license.id }).from(license).where(isNull(license.revokedAt))
  assertEquals(active.length, 0)
})

test('a held lease makes the sync yield to the holder without writing', async () => {
  const db = seed({ seats: [{ tierId: S3, quantity: 1 }] })
  const lock = await tryBeginQuantityMutation(db, ORG, NOW_MS)
  assertEquals(lock !== null, true)
  const outcome = await syncEntitlementsForOrganization(
    { db, client: null, nowMs: NOW_MS, leaseRetry: { attempts: 1, delayMs: 0 } },
    { organizationId: ORG, providerSubscriptionId: 'sub_1', pendingUpdate: false },
  )
  assertEquals(outcome, { action: 'skipped', reason: 'lease_held' })
  assertEquals(await assignments(db), { [SERVER_A]: null, [SERVER_B]: S1 })
})
