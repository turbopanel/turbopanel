/**
 * The `tier` table's writers and the reads every gate goes through. The
 * uniqueness refusals themselves are Postgres's job and are proven in the
 * DB-backed suite; what is proven here is that a row is a label plus a
 * product (rank and custom-ness come from the ladder, never a request),
 * that a patch touches only what it names, that references are seats plus
 * assigned servers, and that the product→tier map and the purchasable gate
 * read the columns the projection and the mutations depend on.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { license, server, subscriptionItem, tier } from './schema.ts'
import {
  countActiveLicenses,
  countTierReferences,
  getTierByLabel,
  insertTier,
  ladderEntryForTier,
  listActiveTiers,
  listAllTiers,
  mapProviderProductsToTierIds,
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
const OTHER_ORG = '00000000-0000-4000-8000-000000000000'
const S3 = '33333333-3333-4333-8333-333333333333'
const S5 = '55555555-5555-4555-8555-555555555555'
const SX = '99999999-9999-4999-8999-999999999999'
const NOW = '2026-09-08T00:00:00.000Z'

function tierRow(overrides: Partial<TierRow> = {}): TierRow {
  return {
    id: S3,
    createdAt: NOW,
    updatedAt: NOW,
    label: 'S3',
    rank: 3,
    provider: 'stripe',
    providerProductId: 'prod_s3',
    priceCents: 1000,
    currency: 'usd',
    isCustom: false,
    isActive: true,
    ...overrides,
  }
}

test('insertTier writes a label plus product row and copies rank and is_custom from the ladder', async () => {
  const db = createMemoryDb([[tier, []]])
  const row = await insertTier(db, { label: 'S3', providerProductId: 'prod_s3', priceCents: 1000, currency: 'usd', now: NOW })
  assertEquals([row.label, row.rank, row.isCustom], ['S3', 3, false])
  assertEquals([row.provider, row.providerProductId, row.priceCents, row.currency], ['stripe', 'prod_s3', 1000, 'usd'])
  assertEquals([row.isActive, row.createdAt, row.updatedAt], [true, NOW, NOW])
  assertEquals(db.rows(tier).length, 1)
  // A plain insert: nothing here resolves a conflict, so a duplicate label
  // reaches Postgres's unique index and the route answers 409.
  assertEquals(db.ops.some((op) => op.startsWith('insert-conflict')), false)
})

test('insertTier refuses a label the ladder does not know before anything is written', async () => {
  const db = createMemoryDb([[tier, []]])
  await assertRejects(
    () => insertTier(db, { label: 'S9', providerProductId: 'prod_s9', priceCents: 1, currency: 'usd' }),
    RangeError,
  )
  assertEquals(db.rows(tier).length, 0)
  assertEquals(db.ops, [])
})

test('a custom (SX) row takes no product and is therefore never purchasable', async () => {
  const db = createMemoryDb([[tier, []]])
  const row = await insertTier(db, { label: 'SX', providerProductId: null, priceCents: null, currency: null, now: NOW })
  assertEquals([row.label, row.rank, row.isCustom, row.providerProductId, row.priceCents], ['SX', 8, true, null, null])
  const resolved = await resolvePurchasableTier(db, row.id)
  assertEquals(resolved, { ok: false, reason: 'uncatalogued' })
})

test('updateTierById touches only the columns the patch names and always the timestamp', async () => {
  const db = createMemoryDb([[tier, [tierRow()]]])
  const updated = await updateTierById(db, S3, { isActive: false }, '2026-09-09T00:00:00.000Z')
  assertEquals(updated?.isActive, false)
  assertEquals(updated?.updatedAt, '2026-09-09T00:00:00.000Z')
  // Everything unnamed survives — identity columns above all.
  assertEquals([updated?.label, updated?.rank, updated?.isCustom], ['S3', 3, false])
  assertEquals([updated?.providerProductId, updated?.priceCents, updated?.currency], ['prod_s3', 1000, 'usd'])
})

test('the patch keys are providerProductId, priceCents, currency and isActive; null clears, undefined leaves alone', async () => {
  const db = createMemoryDb([[tier, [tierRow()]]])
  const repriced = await updateTierById(db, S3, { providerProductId: 'prod_s3_v2', priceCents: 1200, currency: 'usd' }, NOW)
  assertEquals([repriced?.providerProductId, repriced?.priceCents, repriced?.currency], ['prod_s3_v2', 1200, 'usd'])
  const cleared = await updateTierById(db, S3, { providerProductId: null, priceCents: undefined, currency: null }, NOW)
  assertEquals([cleared?.providerProductId, cleared?.priceCents, cleared?.currency], [null, 1200, null])
  // An empty patch is a timestamp bump and nothing else.
  const untouched = await updateTierById(db, S3, {}, '2026-09-10T00:00:00.000Z')
  assertEquals([untouched?.providerProductId, untouched?.priceCents, untouched?.isActive], [null, 1200, true])
  assertEquals(untouched?.updatedAt, '2026-09-10T00:00:00.000Z')
})

test('updateTierById answers null for a row that does not exist', async () => {
  const db = createMemoryDb([[tier, [tierRow()]]])
  assertEquals(await updateTierById(db, S5, { isActive: false }, NOW), null)
})

test('countTierReferences counts projected seats and servers currently assigned the tier', async () => {
  const db = createMemoryDb([
    [tier, [tierRow(), tierRow({ id: S5, label: 'S5', rank: 5, providerProductId: 'prod_s5' })]],
    [subscriptionItem, [
      { id: 'seat-1', tierId: S3, quantity: 2 },
      { id: 'seat-2', tierId: S5, quantity: 1 },
      { id: 'seat-3', subscriptionId: 'other-sub', tierId: S3, quantity: 0 },
    ]],
    [server, [
      { id: 'srv-1', organizationId: ORG, assignedTierId: S3 },
      { id: 'srv-2', organizationId: ORG, assignedTierId: S3 },
      { id: 'srv-3', organizationId: ORG, assignedTierId: S5 },
      // Unassigned (uncovered, or unlicensed) servers reference nothing.
      { id: 'srv-4', organizationId: ORG, assignedTierId: null },
    ]],
  ])
  assertEquals(await countTierReferences(db, S3), { seats: 2, servers: 2 })
  assertEquals(await countTierReferences(db, S5), { seats: 1, servers: 1 })
})

test('an unreferenced row counts zero on both sides', async () => {
  const db = createMemoryDb([[tier, [tierRow()]], [subscriptionItem, []], [server, []]])
  assertEquals(await countTierReferences(db, S3), { seats: 0, servers: 0 })
})

test('listActiveTiers keeps rank order and drops inactive rows; listAllTiers keeps them', async () => {
  const db = createMemoryDb([[tier, [
    tierRow({ id: S5, label: 'S5', rank: 5, providerProductId: 'prod_s5' }),
    tierRow({ id: S3, label: 'S3', rank: 3 }),
    tierRow({ id: SX, label: 'S1', rank: 1, providerProductId: 'prod_s1', isActive: false }),
  ]]])
  assertEquals((await listActiveTiers(db)).map((row) => row.label), ['S3', 'S5'])
  assertEquals((await listAllTiers(db)).map((row) => row.label), ['S1', 'S3', 'S5'])
  assertEquals((await getTierByLabel(db, 'S5'))?.id, S5)
  assertEquals(await getTierByLabel(db, 'S7'), null)
})

test('ladderEntryForTier reads the entitlements by label and is null only for a label off the ladder', () => {
  assertEquals(ladderEntryForTier(tierRow())?.nicSlots, 5)
  assertEquals(ladderEntryForTier({ label: 'SX' })?.isCustom, true)
  assertEquals(ladderEntryForTier({ label: 'S99' }), null)
})

test('mapProviderProductsToTierIds keys on (provider, product), dedupes, drops blanks and omits unknown products', async () => {
  const db = createMemoryDb([[tier, [
    tierRow(),
    tierRow({ id: S5, label: 'S5', rank: 5, providerProductId: 'prod_s5' }),
    // Same product id on another provider: a different catalogue, not a match.
    tierRow({ id: SX, label: 'S1', rank: 1, provider: 'apple', providerProductId: 'prod_s3' }),
  ]]])
  const map = await mapProviderProductsToTierIds(db, 'stripe', ['prod_s3', 'prod_s3', '', 'prod_nope', 'prod_s5'])
  assertEquals([...map.entries()].sort(), [['prod_s3', S3], ['prod_s5', S5]])
  assertEquals(await mapProviderProductsToTierIds(db, 'apple', ['prod_s3']), new Map([['prod_s3', SX]]))
  assertEquals(await mapProviderProductsToTierIds(db, 'stripe', []), new Map())
  // No read at all for an empty list.
  assertEquals(db.ops.filter((op) => op === 'select:tier').length, 2)
})

test('resolvePurchasableTier refuses a missing, retired or uncatalogued row and answers the product id trimmed', async () => {
  const db = createMemoryDb([[tier, [
    tierRow({ providerProductId: '  prod_s3 ' }),
    tierRow({ id: S5, label: 'S5', rank: 5, providerProductId: 'prod_s5', isActive: false }),
    tierRow({ id: SX, label: 'SX', rank: 8, providerProductId: '   ', priceCents: null, currency: null, isCustom: true }),
  ]]])
  const ok = await resolvePurchasableTier(db, S3)
  assertEquals(ok.ok, true)
  if (ok.ok) assertEquals([ok.tier.id, ok.tier.providerProductId, ok.tier.rank], [S3, 'prod_s3', 3])
  assertEquals(await resolvePurchasableTier(db, S5), { ok: false, reason: 'inactive' })
  assertEquals(await resolvePurchasableTier(db, SX), { ok: false, reason: 'uncatalogued' })
  assertEquals(await resolvePurchasableTier(db, '77777777-7777-4777-8777-777777777777'), { ok: false, reason: 'not_found' })
})

test('countActiveLicenses counts unrevoked licenses and the bound subset for one organization', async () => {
  const db = createMemoryDb([[license, [
    { id: 'lic-1', organizationId: ORG, serverId: 'srv-1', revokedAt: null },
    { id: 'lic-2', organizationId: ORG, serverId: null, revokedAt: null },
    // Revoked: not held, bound or not.
    { id: 'lic-3', organizationId: ORG, serverId: 'srv-3', revokedAt: NOW },
    { id: 'lic-4', organizationId: OTHER_ORG, serverId: 'srv-4', revokedAt: null },
  ]]])
  assertEquals(await countActiveLicenses(db, ORG), { active: 2, bound: 1 })
  assertEquals(await countActiveLicenses(db, '11111111-1111-4111-8111-111111111111'), { active: 0, bound: 0 })
})
