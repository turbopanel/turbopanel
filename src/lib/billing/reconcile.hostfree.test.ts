/**
 * The reconciliation sweep: drift detected and reported to the log and the
 * `setting` row, nothing else written. Purchased quantity is compared to
 * licenses held (the mint gate's invariant) and to the derived assignment
 * (a licensed server nothing purchased covers).
 */

import { assertEquals } from '@std/assert'
import { license, payer, server, setting, subscription, subscriptionItem, tier } from '../db/schema.ts'
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
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_BIG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const NOW = '2026-09-07T12:00:00.000Z'
const GIB = 1024 ** 3

const tierRow = (id: string, label: string, rank: number) => ({
  id, createdAt: NOW, updatedAt: NOW, label, rank, provider: 'stripe', providerProductId: `prod_${label}`,
  priceCents: 1000 * rank, currency: 'usd', isCustom: false, isActive: true,
})
const licenseRow = (id: string, serverId: string | null) => ({
  id, organizationId: ORG, serverId, name: null, token: 'x', revokedAt: null, createdAt: NOW, updatedAt: NOW,
})
const serverRow = (id: string, cores: number, createdAt: string) => ({
  id, organizationId: ORG, createdAt, updatedAt: createdAt, assignedTierId: null,
  metadata: { resources: { cpus: [{ cores: { total: cores } }], memory: { totalBytes: 8 * GIB } } },
})

function seed(opts: { s3Seats: number; s5Seats: number; licenses: { id: string; serverId: string | null }[] }) {
  return createMemoryDb([
    [tier, [tierRow(S3, 'S3', 3), tierRow(S5, 'S5', 5)]],
    [payer, [{ id: PAYER, organizationId: ORG, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{ id: SUB, payerId: PAYER, providerSubscriptionId: 'sub_1', status: 'active', currentPeriodEnd: null, scheduleId: null, graceExpiresAt: null, pastDueSince: null, createdAt: NOW, updatedAt: NOW }]],
    [subscriptionItem, [
      { id: 'd1', subscriptionId: SUB, tierId: S3, providerItemId: 'si_3', providerPriceId: 'price_S3', quantity: opts.s3Seats, createdAt: NOW, updatedAt: NOW },
      { id: 'd2', subscriptionId: SUB, tierId: S5, providerItemId: 'si_5', providerPriceId: 'price_S5', quantity: opts.s5Seats, createdAt: NOW, updatedAt: NOW },
    ]],
    [license, opts.licenses.map((l) => licenseRow(l.id, l.serverId))],
    // A 12-core box fits S3; a 256-core box needs S7, which nobody bought.
    [server, [serverRow(SERVER_A, 12, '2026-09-01T00:00:00.000Z'), serverRow(SERVER_BIG, 256, '2026-09-02T00:00:00.000Z')]],
    [setting, []],
  ])
}

test('compareSeatsToLicenses classifies the three drift kinds and explains a surplus by outstanding releases', () => {
  const base = { organizationId: ORG, purchased: 3, releasing: 0, licensesHeld: 3, serversUncovered: [] as string[] }
  assertEquals(compareSeatsToLicenses(base), [])
  // More keys than purchased: the invariant broke.
  assertEquals(compareSeatsToLicenses({ ...base, licensesHeld: 4 }).map((d) => d.kind), ['licenses_exceed_purchased'])
  // Fewer keys than purchased: informational, unless the gap is already being given back.
  assertEquals(compareSeatsToLicenses({ ...base, licensesHeld: 1 }).map((d) => d.kind), ['purchased_unused'])
  assertEquals(compareSeatsToLicenses({ ...base, licensesHeld: 1, releasing: 2 }), [])
  assertEquals(compareSeatsToLicenses({ ...base, licensesHeld: 1, releasing: 1 }).map((d) => d.kind), ['purchased_unused'])
  // An uncovered server is reported on its own and beside either quantity drift.
  const uncovered = compareSeatsToLicenses({ ...base, serversUncovered: [SERVER_BIG] })
  assertEquals(uncovered, [{ ...base, serversUncovered: [SERVER_BIG], kind: 'servers_uncovered' }])
  assertEquals(
    compareSeatsToLicenses({ ...base, licensesHeld: 4, serversUncovered: [SERVER_BIG] }).map((d) => d.kind),
    ['servers_uncovered', 'licenses_exceed_purchased'],
  )
  // Exceeding and unused are exclusive: one comparison, one answer.
  assertEquals(compareSeatsToLicenses({ ...base, licensesHeld: 4, releasing: 5 }).map((d) => d.kind), ['licenses_exceed_purchased'])
})

test('runReconcile reports drift into the setting row and writes nothing else', async () => {
  // Purchased 3; three keys held, two bound; the big box is uncovered.
  const db = seed({
    s3Seats: 1,
    s5Seats: 2,
    licenses: [{ id: 'l1', serverId: SERVER_A }, { id: 'l2', serverId: SERVER_BIG }, { id: 'l3', serverId: null }],
  })
  // One S5 seat is already given back locally.
  const intent = newDeferredIntent('release-seat', { fromTierId: S5, toTierId: null, landsAt: null, fromQuantity: 2, nowMs: Date.parse(NOW) })
  await writePendingChanges(db, ORG, withIntent(emptyLedger('sub_1'), intent), Date.parse(NOW))
  const before = {
    licenses: JSON.stringify(db.rows(license)),
    seats: JSON.stringify(db.rows(subscriptionItem)),
    subscription: JSON.stringify(db.rows(subscription)),
    servers: JSON.stringify(db.rows(server)),
  }
  const report = await runReconcile({ db, nowMs: Date.parse(NOW) })
  assertEquals(report.organizations, 1)
  assertEquals(report.drift, [{
    organizationId: ORG,
    kind: 'servers_uncovered',
    purchased: 3,
    releasing: 1,
    licensesHeld: 3,
    serversUncovered: [SERVER_BIG],
  }])
  // Nothing but the report row moved — the assignment is computed, never cached, here.
  assertEquals(JSON.stringify(db.rows(license)), before.licenses)
  assertEquals(JSON.stringify(db.rows(subscriptionItem)), before.seats)
  assertEquals(JSON.stringify(db.rows(subscription)), before.subscription)
  assertEquals(JSON.stringify(db.rows(server)), before.servers)
  assertEquals(db.ops.filter((op) => op.startsWith('update:') || op.startsWith('delete:')), [])
  assertEquals(db.rows(setting).some((row) => row.key === BILLING_RECONCILE_REPORT_KEY), true)
  const stored = await readReconcileReport(db)
  assertEquals(stored?.ranAt, NOW)
  assertEquals(stored?.drift, report.drift)
})

test('a fourth key over three purchased is licenses_exceed_purchased; an unused purchase is reported on its own', async () => {
  const exceeded = seed({
    s3Seats: 1,
    s5Seats: 2,
    licenses: [{ id: 'l1', serverId: SERVER_A }, { id: 'l2', serverId: null }, { id: 'l3', serverId: null }, { id: 'l4', serverId: null }],
  })
  const report = await runReconcile({ db: exceeded, nowMs: Date.parse(NOW) })
  assertEquals(report.drift.map((d) => [d.kind, d.purchased, d.licensesHeld, d.serversUncovered]), [
    ['licenses_exceed_purchased', 3, 4, []],
  ])
  const unused = seed({ s3Seats: 1, s5Seats: 2, licenses: [{ id: 'l1', serverId: SERVER_A }] })
  const info = await runReconcile({ db: unused, nowMs: Date.parse(NOW) })
  assertEquals(info.drift.map((d) => [d.kind, d.purchased, d.releasing, d.licensesHeld]), [['purchased_unused', 3, 0, 1]])
})

test('a clean organization produces an empty report; an ended subscription is skipped', async () => {
  const db = seed({ s3Seats: 1, s5Seats: 0, licenses: [{ id: 'l1', serverId: SERVER_A }] })
  const clean = await runReconcile({ db, nowMs: Date.parse(NOW) })
  assertEquals(clean.drift, [])
  db.rows(subscription)[0]!.status = 'canceled'
  const ended = await runReconcile({ db, nowMs: Date.parse(NOW) })
  assertEquals(ended.drift, [])
  assertEquals(ended.organizations, 1)
})

test('the divisor predicate fires hourly', () => {
  assertEquals(shouldRunReconcile(0), true)
  assertEquals(shouldRunReconcile(60_000), false)
  assertEquals(shouldRunReconcile(RECONCILE_SWEEP_MINUTE_DIVISOR * 60_000), true)
})
