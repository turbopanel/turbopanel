/**
 * The derived assignment, persisted: `server.assigned_tier_id` is written
 * only for the rows whose tier moved. An organization without a payer still
 * assigns from its self-hosted grant; a server outside any organization is
 * left alone. Hardware → required rank treats an unreported box as unknown.
 */

import { assertEquals } from '@std/assert'
import { license, payer, server, setting, subscription, subscriptionItem, tier } from '../db/schema.ts'
import { listSeatsForOrganization } from '../db/billing-records.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  clearAssignmentsForServers,
  loadAssignableServers,
  recomputeAssignmentsForServer,
  recomputeOrganizationAssignments,
  requiredRankFromMetadata,
  requiredRankFromResources,
  tierQuantitiesFromState,
} from './assignment-records.ts'
import { CUSTOM_TIER_LABEL } from './ladder.ts'
import { SELF_HOSTED_GRANT_VERSION, selfHostedGrantKey } from './self-hosted-grant.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const OTHER_ORG = '00000000-0000-4000-8000-000000000000'
const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S1 = '11111111-1111-4111-8111-111111111111'
const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const SX = '88888888-8888-4888-8888-888888888888'
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SERVER_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SERVER_UNLICENSED = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const NOW = '2026-09-07T12:00:00.000Z'
const GIB = 1024 ** 3

const tierRow = (id: string, label: string, rank: number) => ({
  id, createdAt: NOW, updatedAt: NOW, label, rank, provider: 'stripe', providerProductId: `prod_${label}`,
  priceCents: 1000 * rank, currency: 'usd', isCustom: false, isActive: true,
})
const hardware = (cores: number, memoryGib = 8) => ({ resources: { cpus: [{ cores: { total: cores } }], memory: { totalBytes: memoryGib * GIB } } })
const serverRow = (id: string, createdAt: string, metadata: unknown, assignedTierId: string | null, organizationId: string | null = ORG) => ({
  id, organizationId, createdAt, updatedAt: createdAt, metadata, assignedTierId,
})
const licenseRow = (id: string, serverId: string | null, revokedAt: string | null = null) => ({
  id, organizationId: ORG, serverId, name: null, token: 'x', revokedAt, createdAt: NOW, updatedAt: NOW,
})

function seed(opts: {
  seats?: { tierId: string; quantity: number }[]
  status?: string
  payer?: boolean
  grantQuantity?: number
  servers?: ReturnType<typeof serverRow>[]
  licenses?: ReturnType<typeof licenseRow>[]
}) {
  const sxRow = {
    ...tierRow(SX, CUSTOM_TIER_LABEL, 8),
    providerProductId: null,
    priceCents: null,
    currency: null,
    isCustom: true,
  }
  const grantRows = opts.grantQuantity
    ? [{
      id: 'setting-grant',
      key: selfHostedGrantKey(ORG),
      value: { version: SELF_HOSTED_GRANT_VERSION, tierId: SX, quantity: opts.grantQuantity },
      createdAt: NOW,
      updatedAt: NOW,
    }]
    : []
  return createMemoryDb([
    [tier, [tierRow(S1, 'S1', 1), tierRow(S3, 'S3', 3), tierRow(S5, 'S5', 5), sxRow]],
    [setting, grantRows],
    [payer, opts.payer === false ? [] : [{ id: PAYER, organizationId: ORG, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: NOW, updatedAt: NOW }]],
    [subscription, [{ id: SUB, payerId: PAYER, providerSubscriptionId: 'sub_1', status: opts.status ?? 'active', currentPeriodEnd: null, scheduleId: null, graceExpiresAt: null, pastDueSince: null, createdAt: NOW, updatedAt: NOW }]],
    [subscriptionItem, (opts.seats ?? []).map((seat, index) => ({
      id: `seat-${index}`, subscriptionId: SUB, tierId: seat.tierId, providerItemId: `si_${index}`, providerPriceId: `price_${index}`,
      quantity: seat.quantity, createdAt: NOW, updatedAt: NOW,
    }))],
    [server, opts.servers ?? []],
    [license, opts.licenses ?? []],
  ])
}

test('requiredRankFromResources / Metadata: reported hardware places, unreported hardware is unknown', () => {
  assertEquals(requiredRankFromResources(undefined), null)
  assertEquals(requiredRankFromResources({}), null)
  assertEquals(requiredRankFromResources({ cpus: [{ cores: { total: 0 } }] }), null)
  assertEquals(requiredRankFromResources({ cpus: [{ cores: { total: 4 } }], memory: { totalBytes: 16 * GIB } }), 1)
  assertEquals(requiredRankFromResources({ cpus: [{ cores: { total: 12 } }] }), 3)
  // RAM alone is enough to know the box; the harder of the two wins.
  assertEquals(requiredRankFromResources({ memory: { totalBytes: 100 * GIB } }), 4)
  assertEquals(requiredRankFromMetadata(hardware(12, 200)), 5)
  assertEquals(requiredRankFromMetadata(null), null)
  assertEquals(requiredRankFromMetadata({ resources: 'nope' }), null)
  assertEquals(requiredRankFromMetadata({ cell: { generation: 1 } }), null)
})

test('tierQuantitiesFromState sums per tier with its rank and reads zero once the subscription ended', async () => {
  const live = seed({ seats: [{ tierId: S3, quantity: 2 }, { tierId: S1, quantity: 1 }, { tierId: S3, quantity: 1 }] })
  assertEquals(tierQuantitiesFromState(await listSeatsForOrganization(live, ORG)), [
    { tierId: S1, rank: 1, quantity: 1 },
    { tierId: S3, rank: 3, quantity: 3 },
  ])
  const ended = seed({ status: 'canceled', seats: [{ tierId: S3, quantity: 2 }] })
  assertEquals(tierQuantitiesFromState(await listSeatsForOrganization(ended, ORG)), [{ tierId: S3, rank: 3, quantity: 0 }])
  assertEquals(tierQuantitiesFromState({ payer: null, subscription: null, seats: [], grant: null }), [])
})

test('loadAssignableServers is every licensed server of the organization with its requirement and cached assignment', async () => {
  const db = seed({
    servers: [
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(12), S3),
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', null, null),
      serverRow(SERVER_UNLICENSED, '2026-09-01T00:00:00.000Z', hardware(2), null),
      serverRow(SERVER_C, '2026-09-03T00:00:00.000Z', hardware(2), null),
      serverRow('other-org', '2026-09-01T00:00:00.000Z', hardware(2), null, OTHER_ORG),
    ],
    licenses: [
      licenseRow('l-a', SERVER_A),
      licenseRow('l-b', SERVER_B),
      // Revoked: the server no longer holds a license.
      licenseRow('l-c', SERVER_C, NOW),
      licenseRow('l-free', null),
    ],
  })
  const rows = await loadAssignableServers(db, ORG)
  assertEquals(rows.map((row) => [row.serverId, row.requiredRank, row.boundAt, row.assignedTierId]), [
    [SERVER_B, 3, '2026-09-02T00:00:00.000Z', S3],
    [SERVER_A, null, '2026-09-01T00:00:00.000Z', null],
  ])
})

test('recomputeOrganizationAssignments writes assigned_tier_id only for the rows that moved', async () => {
  const db = seed({
    seats: [{ tierId: S1, quantity: 1 }, { tierId: S3, quantity: 1 }],
    servers: [
      // Already on the right tier: untouched.
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S1),
      // Stale: cached on S1, needs S3.
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(12), S1),
      // Nothing left for a third licensed box: stale S3 is cleared.
      serverRow(SERVER_C, '2026-09-03T00:00:00.000Z', hardware(2), S3),
      // Unlicensed: never read, never written.
      serverRow(SERVER_UNLICENSED, '2026-09-01T00:00:00.000Z', hardware(2), S5),
    ],
    licenses: [licenseRow('l-a', SERVER_A), licenseRow('l-b', SERVER_B), licenseRow('l-c', SERVER_C)],
  })
  const result = await recomputeOrganizationAssignments(db, ORG, { now: NOW })
  assertEquals([...result.assignment.byServer], [[SERVER_A, S1], [SERVER_B, S3], [SERVER_C, null]])
  assertEquals(result.changed, [SERVER_B, SERVER_C])
  assertEquals(result.uncovered, [SERVER_C])
  const byId = new Map(db.rows(server).map((row) => [row.id, row]))
  assertEquals([byId.get(SERVER_A)?.assignedTierId, byId.get(SERVER_A)?.updatedAt], [S1, '2026-09-01T00:00:00.000Z'])
  assertEquals([byId.get(SERVER_B)?.assignedTierId, byId.get(SERVER_B)?.updatedAt], [S3, NOW])
  assertEquals([byId.get(SERVER_C)?.assignedTierId, byId.get(SERVER_C)?.updatedAt], [null, NOW])
  assertEquals(byId.get(SERVER_UNLICENSED)?.assignedTierId, S5)
  assertEquals(db.ops.filter((op) => op === 'update:server').length, result.changed.length)
  assertEquals(db.ops.filter((op) => op.startsWith('insert:') || op.startsWith('delete:')), [])

  // A second pass is a pure read: everything is where it should be.
  const again = await recomputeOrganizationAssignments(db, ORG, { now: '2026-09-08T00:00:00.000Z' })
  assertEquals(again.changed, [])
  assertEquals(db.ops.filter((op) => op === 'update:server').length, 2)
})

test('an already-loaded state skips the billing read, and an ended subscription clears every assignment', async () => {
  const db = seed({
    status: 'canceled',
    seats: [{ tierId: S3, quantity: 2 }],
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S3)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const state = await listSeatsForOrganization(db, ORG)
  const opsBefore = db.ops.length
  const result = await recomputeOrganizationAssignments(db, ORG, { state, now: NOW })
  assertEquals(db.ops.slice(opsBefore).filter((op) => op.startsWith('select:')), ['select:server'])
  assertEquals(result.changed, [SERVER_A])
  assertEquals(result.uncovered, [SERVER_A])
  assertEquals(db.rows(server)[0]?.assignedTierId, null)
})

test('recomputeAssignmentsForServer recomputes the organization the server belongs to', async () => {
  const db = seed({
    seats: [{ tierId: S3, quantity: 1 }],
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), null)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const result = await recomputeAssignmentsForServer(db, SERVER_A)
  assertEquals(result?.changed, [SERVER_A])
  assertEquals(db.rows(server)[0]?.assignedTierId, S3)
})

test('recomputeAssignmentsForServer assigns from the self-hosted grant when there is no payer', async () => {
  const db = seed({
    payer: false,
    grantQuantity: 1,
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), null)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const result = await recomputeAssignmentsForServer(db, SERVER_A)
  assertEquals(result?.changed, [SERVER_A])
  assertEquals(result?.uncovered, [])
  assertEquals(db.rows(server)[0]?.assignedTierId, SX)
})

test('recomputeAssignmentsForServer with no payer and no grant leaves a licensed server uncovered', async () => {
  const stale = seed({
    payer: false,
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), S3)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const cleared = await recomputeAssignmentsForServer(stale, SERVER_A)
  assertEquals(cleared?.uncovered, [SERVER_A])
  assertEquals(stale.rows(server)[0]?.assignedTierId, null)
  assertEquals(stale.ops.filter((op) => op === 'update:server').length, 1)

  const clean = seed({
    payer: false,
    servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), null)],
    licenses: [licenseRow('l-a', SERVER_A)],
  })
  const empty = await recomputeAssignmentsForServer(clean, SERVER_A)
  assertEquals(empty?.changed, [])
  assertEquals(empty?.uncovered, [SERVER_A])
  assertEquals(clean.ops.filter((op) => op.startsWith('update:')), [])

  // A server outside any organization, or one that does not exist, is left alone.
  const orphan = seed({ servers: [serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(12), S3, null)] })
  assertEquals(await recomputeAssignmentsForServer(orphan, SERVER_A), null)
  assertEquals(orphan.rows(server)[0]?.assignedTierId, S3)
  assertEquals(orphan.ops, ['select:server'])
  assertEquals(await recomputeAssignmentsForServer(orphan, SERVER_B), null)
})

test('clearAssignmentsForServers nulls exactly the named rows and skips the write for none', async () => {
  const db = seed({
    servers: [
      serverRow(SERVER_A, '2026-09-01T00:00:00.000Z', hardware(2), S1),
      serverRow(SERVER_B, '2026-09-02T00:00:00.000Z', hardware(2), S3),
      serverRow(SERVER_C, '2026-09-03T00:00:00.000Z', hardware(2), S5),
    ],
  })
  await clearAssignmentsForServers(db, [])
  assertEquals(db.ops, [])
  await clearAssignmentsForServers(db, [SERVER_A, SERVER_C])
  assertEquals(db.rows(server).map((row) => row.assignedTierId), [null, S3, null])
  assertEquals(db.ops, ['update:server'])
})
