/**
 * The reconciliation sweep: drift detected and reported to the log and the
 * `setting` row, nothing else written.
 */

import { assertEquals } from '@std/assert'
import { license, payer, setting, subscription, subscriptionItem, tier } from '../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { emptyLedger, newDeferredIntent, withIntent, writePendingChanges } from './pending-changes.ts'
import {
  BILLING_RECONCILE_REPORT_KEY,
  compareSeatsToLicenses,
  readReconcileReport,
  RECONCILE_SWEEP_MINUTE_DIVISOR,
  runReconcile,
  shouldRunReconcile,
} from './reconcile.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const SERVER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NOW = '2026-09-07T12:00:00.000Z'

const tierRow = (id: string, label: string, rank: number) => ({
  id, label, generation: 1, rank, priceCents: 1000 * rank, providerPriceId: `price_${label}`, isCustom: false, isActive: true,
  successorId: null, maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1, createdAt: NOW, updatedAt: NOW,
})
const licenseRow = (id: string, tierId: string, serverId: string | null) => ({
  id, organizationId: ORG, serverId, tierId, name: null, token: 'x', revokedAt: null, createdAt: NOW, updatedAt: NOW,
})

function seed(opts: { s3Seats: number; s5Seats: number; licenses: { id: string; tierId: string; serverId: string | null }[] }) {
  return createMemoryDb([
    [tier, [tierRow(S3, 'S3', 3), tierRow(S5, 'S5', 5)]],
    [payer, [{ id: PAYER, organizationId: ORG, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{ id: SUB, payerId: PAYER, providerSubscriptionId: 'sub_1', status: 'active', currentPeriodEnd: null, scheduleId: null, graceExpiresAt: null, pastDueSince: null, createdAt: NOW, updatedAt: NOW }]],
    [subscriptionItem, [
      { id: 'd1', subscriptionId: SUB, tierId: S3, providerItemId: 'si_3', quantity: opts.s3Seats, createdAt: NOW, updatedAt: NOW },
      { id: 'd2', subscriptionId: SUB, tierId: S5, providerItemId: 'si_5', quantity: opts.s5Seats, createdAt: NOW, updatedAt: NOW },
    ]],
    [license, opts.licenses.map((l) => licenseRow(l.id, l.tierId, l.serverId))],
    [setting, []],
  ])
}

test('compareSeatsToLicenses classifies the three shapes and explains a surplus by outstanding releases', () => {
  const drift = compareSeatsToLicenses({
    organizationId: ORG,
    seats: new Map([[S3, 2], [S5, 1]]),
    counts: new Map([[S3, { active: 3, bound: 3 }], [S5, { active: 0, bound: 0 }]]),
    releases: new Map([[S5, 1]]),
  })
  assertEquals(drift.map((d) => `${d.tierId === S3 ? 'S3' : 'S5'}:${d.kind}`), ['S3:seats_below_bound'])
  const surplus = compareSeatsToLicenses({
    organizationId: ORG,
    seats: new Map([[S5, 2]]),
    counts: new Map([[S5, { active: 1, bound: 0 }]]),
    releases: new Map(),
  })
  assertEquals(surplus[0]?.kind, 'seats_unused')
  const exceed = compareSeatsToLicenses({
    organizationId: ORG,
    seats: new Map([[S5, 1]]),
    counts: new Map([[S5, { active: 2, bound: 1 }]]),
    releases: new Map(),
  })
  assertEquals(exceed[0]?.kind, 'licenses_exceed_seats')
})

test('runReconcile reports drift into the setting row and writes nothing else', async () => {
  const db = seed({
    s3Seats: 1,
    s5Seats: 2,
    licenses: [
      { id: 'l1', tierId: S3, serverId: SERVER },
      { id: 'l2', tierId: S3, serverId: null },
    ],
  })
  // One S5 seat is already given back locally; the other is truly unused.
  await writePendingChanges(db, ORG, withIntent(emptyLedger('sub_1'), newDeferredIntent('release-seat', { licenseId: null, fromTierId: S5, toTierId: null })), Date.parse(NOW))
  const before = {
    licenses: JSON.stringify(db.rows(license)),
    seats: JSON.stringify(db.rows(subscriptionItem)),
    subscription: JSON.stringify(db.rows(subscription)),
  }
  const report = await runReconcile({ db, nowMs: Date.parse(NOW) })
  assertEquals(report.organizations, 1)
  assertEquals(report.drift.map((d) => [d.tierId === S3 ? 'S3' : 'S5', d.kind, d.seats, d.active, d.bound, d.outstandingReleases]), [
    ['S3', 'licenses_exceed_seats', 1, 2, 1, 0],
    ['S5', 'seats_unused', 2, 0, 0, 1],
  ])
  // Nothing but the report row moved.
  assertEquals(JSON.stringify(db.rows(license)), before.licenses)
  assertEquals(JSON.stringify(db.rows(subscriptionItem)), before.seats)
  assertEquals(JSON.stringify(db.rows(subscription)), before.subscription)
  assertEquals(db.ops.filter((op) => op.startsWith('update:') || op.startsWith('delete:')), [])
  assertEquals(db.rows(setting).some((row) => row.key === BILLING_RECONCILE_REPORT_KEY), true)
  const stored = await readReconcileReport(db)
  assertEquals(stored?.ranAt, NOW)
  assertEquals(stored?.drift.length, 2)
})

test('a clean organization produces an empty report; an ended subscription is skipped', async () => {
  const db = seed({ s3Seats: 1, s5Seats: 0, licenses: [{ id: 'l1', tierId: S3, serverId: SERVER }] })
  const clean = await runReconcile({ db, nowMs: Date.parse(NOW) })
  assertEquals(clean.drift, [])
  db.rows(subscription)[0]!.status = 'canceled'
  db.rows(subscriptionItem)[0]!.quantity = 0
  const ended = await runReconcile({ db, nowMs: Date.parse(NOW) })
  assertEquals(ended.drift, [])
})

test('the divisor predicate fires hourly', () => {
  assertEquals(shouldRunReconcile(0), true)
  assertEquals(shouldRunReconcile(60_000), false)
  assertEquals(shouldRunReconcile(RECONCILE_SWEEP_MINUTE_DIVISOR * 60_000), true)
})
