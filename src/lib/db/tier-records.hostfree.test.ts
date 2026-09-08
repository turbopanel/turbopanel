/**
 * The `tier` table's writers and the reference count the admin routes gate
 * on. The uniqueness refusals themselves are Postgres's job and are proven
 * in the DB-backed suite; what is proven here is that the seed's converging
 * upsert is gone, that a patch touches only what it names, and that a
 * revoked license still counts as a reference.
 */

import { assertEquals } from '@std/assert'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { license, subscriptionItem, tier } from './schema.ts'
import {
  countTierReferences,
  insertTier,
  listActiveTiers,
  resolvePurchasableTier,
  type TierRow,
  updateTierById,
} from './tier-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const NOW = '2026-09-08T00:00:00.000Z'

function tierRow(overrides: Partial<TierRow> = {}): TierRow {
  return {
    id: S3,
    createdAt: NOW,
    updatedAt: NOW,
    generation: 1,
    rank: 3,
    label: 'S3',
    priceCents: 1000,
    providerPriceId: 'price_s3',
    isCustom: false,
    isActive: true,
    successorId: null,
    maxCores: 16,
    maxMemoryBytes: 68_719_476_736,
    nicSlots: 5,
    driveSlots: 6,
    gpuSlots: 2,
    filesystemSlots: 9,
    ...overrides,
  } as TierRow
}

function insertInput(overrides: Record<string, unknown> = {}) {
  return {
    generation: 1,
    label: 'S3',
    rank: 3,
    priceCents: 1000,
    providerPriceId: 'price_s3',
    isCustom: false,
    isActive: true,
    maxCores: 16,
    maxMemoryBytes: 68_719_476_736,
    nicSlots: 5,
    driveSlots: 6,
    gpuSlots: 2,
    filesystemSlots: 9,
    now: NOW,
    ...overrides,
  }
}

test('insertTier writes one row with every catalogue column and no conflict clause', async () => {
  const db = createMemoryDb([[tier, []]])
  const row = await insertTier(db, insertInput())
  assertEquals([row.label, row.generation, row.rank], ['S3', 1, 3])
  assertEquals([row.priceCents, row.providerPriceId], [1000, 'price_s3'])
  assertEquals([row.maxCores, row.nicSlots, row.driveSlots, row.gpuSlots, row.filesystemSlots], [16, 5, 6, 2, 9])
  assertEquals([row.isCustom, row.isActive, row.successorId], [false, true, null])
  assertEquals(db.rows(tier).length, 1)
  // A plain insert: nothing here resolves a conflict, so a duplicate label
  // reaches Postgres's unique index and the route answers 409.
  assertEquals(db.ops.some((op) => op.startsWith('insert-conflict')), false)
})

test('a custom row carries no price and no price id', async () => {
  const db = createMemoryDb([[tier, []]])
  const row = await insertTier(db, insertInput({ label: 'SX', rank: 8, priceCents: null, providerPriceId: null, isCustom: true }))
  assertEquals([row.label, row.priceCents, row.providerPriceId, row.isCustom], ['SX', null, null, true])
  // …and it is therefore never purchasable, which the mutation gate relies on.
  const resolved = await resolvePurchasableTier(db, row.id)
  assertEquals(resolved, { ok: false, reason: 'uncatalogued' })
})

test('updateTierById touches only the columns the patch names and always the timestamp', async () => {
  const db = createMemoryDb([[tier, [tierRow()]]])
  const updated = await updateTierById(db, S3, { isActive: false }, '2026-09-09T00:00:00.000Z')
  assertEquals(updated?.isActive, false)
  assertEquals(updated?.updatedAt, '2026-09-09T00:00:00.000Z')
  // Everything unnamed survives.
  assertEquals([updated?.rank, updated?.priceCents, updated?.providerPriceId], [3, 1000, 'price_s3'])
  assertEquals(updated?.label, 'S3')
})

test('an explicit null clears a nullable column; undefined does not', async () => {
  const db = createMemoryDb([[tier, [tierRow()]]])
  const cleared = await updateTierById(db, S3, { providerPriceId: null, priceCents: undefined }, NOW)
  assertEquals(cleared?.providerPriceId, null)
  assertEquals(cleared?.priceCents, 1000)
})

test('updateTierById answers null for a row that does not exist', async () => {
  const db = createMemoryDb([[tier, [tierRow()]]])
  assertEquals(await updateTierById(db, S5, { isActive: false }, NOW), null)
})

test('countTierReferences counts revoked licenses and projected seats', async () => {
  const db = createMemoryDb([
    [tier, [tierRow(), tierRow({ id: S5, label: 'S5', rank: 5 })]],
    [license, [
      { id: 'lic-1', organizationId: ORG, tierId: S3, revokedAt: null, serverId: null },
      // Revoked, and still a reference: the FK restricts and the row's
      // history is written in terms of what this tier meant.
      { id: 'lic-2', organizationId: ORG, tierId: S3, revokedAt: NOW, serverId: null },
      { id: 'lic-3', organizationId: ORG, tierId: S5, revokedAt: null, serverId: null },
      { id: 'lic-4', organizationId: ORG, tierId: null, revokedAt: null, serverId: null },
    ]],
    [subscriptionItem, [
      { id: 'seat-1', tierId: S3, quantity: 2 },
      { id: 'seat-2', tierId: S5, quantity: 1 },
    ]],
  ])
  assertEquals(await countTierReferences(db, S3), { licenses: 2, seats: 1 })
  assertEquals(await countTierReferences(db, S5), { licenses: 1, seats: 1 })
})

test('an unreferenced row counts zero on both sides', async () => {
  const db = createMemoryDb([[tier, [tierRow()]], [license, []], [subscriptionItem, []]])
  assertEquals(await countTierReferences(db, S3), { licenses: 0, seats: 0 })
})

test('listActiveTiers keeps generation-then-rank order and drops inactive rows', async () => {
  const db = createMemoryDb([[tier, [
    tierRow({ id: S5, label: 'S5', rank: 5 }),
    tierRow({ id: S3, label: 'S3', rank: 3 }),
    tierRow({ id: '99999999-9999-4999-8999-999999999999', label: 'S1', rank: 1, isActive: false }),
  ]]])
  assertEquals((await listActiveTiers(db)).map((row) => row.label), ['S3', 'S5'])
})
