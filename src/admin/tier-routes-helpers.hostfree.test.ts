/**
 * The pure half of the superadmin tier catalogue: the two body parsers and
 * the serializers. No Hono, no provider, no Postgres — what is pinned here
 * is that a create body is refused for the right reason, a patch takes
 * only the two keys it documents, and every serialized shape reads its
 * entitlements from the ladder rather than from the row.
 */

import { assertEquals } from '@std/assert'
import type { ProductVerification, ProviderProduct } from '../lib/billing/gateway.ts'
import type { TierRow } from '../lib/db/tier-records.ts'
import { LADDER } from '../lib/tiers/ladder.ts'
import {
  ladderWithRows,
  parseTierCreateBody,
  parseTierPatchBody,
  serializeAdminTier,
  serializeLadderEntry,
  serializeProduct,
} from './tier-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const S3_ID = '33333333-3333-4333-8333-333333333333'
const SX_ID = '88888888-8888-4888-8888-888888888888'
const NOW = '2026-09-08T00:00:00.000Z'

function tierRow(overrides: Partial<TierRow> = {}): TierRow {
  return {
    id: S3_ID,
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

function providerProduct(overrides: Partial<ProviderProduct> = {}): ProviderProduct {
  return {
    id: 'prod_s3',
    name: 'S3',
    active: true,
    livemode: false,
    metadata: { turbopanel_tier: 'S3' },
    suggestedLabel: 'S3',
    defaultPrice: {
      id: 'price_s3',
      active: true,
      type: 'recurring',
      currency: 'usd',
      unitAmount: 1000,
      interval: 'month',
      intervalCount: 1,
      billingScheme: 'per_unit',
      taxBehavior: 'exclusive',
      livemode: false,
    },
    ...overrides,
  }
}

function verification(product: ProviderProduct, failures: string[] = []): ProductVerification {
  return { ok: failures.length === 0, product, failures }
}

const S3_ENTITLEMENTS = {
  maxCores: 16,
  maxMemoryBytes: 64 * 1024 ** 3,
  nicSlots: 5,
  driveSlots: 6,
  gpuSlots: 2,
  filesystemSlots: 9,
}

// ---------------------------------------------------------------------------
// parseTierCreateBody
// ---------------------------------------------------------------------------

test('parseTierCreateBody accepts a priced label with a product, folding case and whitespace', () => {
  assertEquals(
    parseTierCreateBody({ label: 'S3', providerProductId: 'prod_s3' }),
    { label: 'S3', providerProductId: 'prod_s3' },
  )
  assertEquals(
    parseTierCreateBody({ label: ' s3 ', providerProductId: '  prod_s3  ' }),
    { label: 'S3', providerProductId: 'prod_s3' },
  )
})

test('parseTierCreateBody accepts SX with no product and refuses SX with one', () => {
  assertEquals(parseTierCreateBody({ label: 'SX' }), { label: 'SX', providerProductId: null })
  assertEquals(parseTierCreateBody({ label: 'sx', providerProductId: null }), { label: 'SX', providerProductId: null })
  assertEquals(parseTierCreateBody({ label: 'SX', providerProductId: '' }), { label: 'SX', providerProductId: null })
  const refused = parseTierCreateBody({ label: 'SX', providerProductId: 'prod_sx' })
  assertEquals('error' in refused, true)
  assertEquals('error' in refused && refused.error.includes('takes no product'), true)
})

test('parseTierCreateBody refuses a label off the ladder, naming every label it takes', () => {
  for (const body of [{}, { label: 'S9' }, { label: 'gold' }, { label: 3 }, { label: '' }]) {
    const refused = parseTierCreateBody(body)
    assertEquals('error' in refused, true, JSON.stringify(body))
    if ('error' in refused) {
      for (const entry of LADDER) assertEquals(refused.error.includes(entry.label), true)
    }
  }
})

test('parseTierCreateBody refuses a priced label with a missing, blank, or non-string product', () => {
  for (const body of [{ label: 'S3' }, { label: 'S3', providerProductId: null }, { label: 'S3', providerProductId: '   ' }]) {
    const refused = parseTierCreateBody(body)
    assertEquals('error' in refused && refused.error.includes('S3 needs the provider product'), true, JSON.stringify(body))
  }
  const typed = parseTierCreateBody({ label: 'S3', providerProductId: 7 })
  assertEquals(typed, { error: 'providerProductId must be a string' })
})

// ---------------------------------------------------------------------------
// parseTierPatchBody
// ---------------------------------------------------------------------------

test('parseTierPatchBody carries only the keys that were sent', () => {
  assertEquals(parseTierPatchBody({}), {})
  assertEquals(parseTierPatchBody({ providerProductId: 'prod_other' }), { providerProductId: 'prod_other' })
  assertEquals(parseTierPatchBody({ providerProductId: ' prod_other ' }), { providerProductId: 'prod_other' })
  assertEquals(parseTierPatchBody({ isActive: false }), { isActive: false })
  assertEquals(
    parseTierPatchBody({ providerProductId: 'prod_other', isActive: true }),
    { providerProductId: 'prod_other', isActive: true },
  )
})

test('parseTierPatchBody reads null and blank as clearing the product', () => {
  assertEquals(parseTierPatchBody({ providerProductId: null }), { providerProductId: null })
  assertEquals(parseTierPatchBody({ providerProductId: '' }), { providerProductId: null })
  assertEquals(parseTierPatchBody({ providerProductId: '   ' }), { providerProductId: null })
})

test('parseTierPatchBody refuses wrong types and names unknown keys', () => {
  assertEquals(parseTierPatchBody({ providerProductId: 7 }), { error: 'providerProductId must be a string' })
  assertEquals(parseTierPatchBody({ isActive: 'yes' }), { error: 'isActive must be a boolean' })
  assertEquals(parseTierPatchBody({ isActive: null }), { error: 'isActive must be a boolean' })
  // Identity columns and the old entitlement columns are not patchable.
  assertEquals(parseTierPatchBody({ label: 'S4' }), { error: 'unknown field(s): label' })
  assertEquals(
    parseTierPatchBody({ isActive: true, rank: 4, nicSlots: 8 }),
    { error: 'unknown field(s): rank, nicSlots' },
  )
})

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

test('serializeAdminTier reads entitlements from the ladder and carries the references', () => {
  const out = serializeAdminTier(tierRow(), { seats: 2, servers: 1 })
  assertEquals(out, {
    id: S3_ID,
    label: 'S3',
    rank: 3,
    provider: 'stripe',
    providerProductId: 'prod_s3',
    priceCents: 1000,
    currency: 'usd',
    isCustom: false,
    isActive: true,
    entitlements: S3_ENTITLEMENTS,
    references: { seats: 2, servers: 1 },
    createdAt: NOW,
    updatedAt: NOW,
  })
})

test('serializeAdminTier reports null entitlements for a label the ladder no longer knows', () => {
  const out = serializeAdminTier(tierRow({ label: 'S0', rank: 0 }), { seats: 0, servers: 0 })
  assertEquals(out.entitlements, null)
  assertEquals(out.label, 'S0')
})

test('serializeLadderEntry carries rank, custom flag, list price and the slot budgets', () => {
  const s3 = LADDER.find((entry) => entry.label === 'S3')!
  assertEquals(serializeLadderEntry(s3), {
    label: 'S3',
    rank: 3,
    isCustom: false,
    listPriceCents: 1000,
    entitlements: S3_ENTITLEMENTS,
  })
  const sx = serializeLadderEntry(LADDER.find((entry) => entry.label === 'SX')!)
  assertEquals(sx.isCustom, true)
  assertEquals(sx.listPriceCents, null)
})

test('ladderWithRows lists every ladder label in rank order with the id of the row that maps it', () => {
  const out = ladderWithRows([
    tierRow({ id: SX_ID, label: 'SX', rank: 8, providerProductId: null, priceCents: null, currency: null, isCustom: true }),
    tierRow(),
  ])
  assertEquals(out.map((entry) => entry.label), ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'SX'])
  assertEquals(out.map((entry) => entry.rank), [1, 2, 3, 4, 5, 6, 7, 8])
  assertEquals(out.map((entry) => entry.tierId), [null, null, S3_ID, null, null, null, null, SX_ID])
  assertEquals(out[2]?.entitlements, S3_ENTITLEMENTS)
  // An empty catalogue maps nothing.
  assertEquals(ladderWithRows([]).every((entry) => entry.tierId === null), true)
})

test('serializeProduct flattens the default price, echoes the verification and names the bound tier', () => {
  const product = providerProduct()
  assertEquals(serializeProduct(product, verification(product), S3_ID), {
    id: 'prod_s3',
    name: 'S3',
    active: true,
    livemode: false,
    suggestedLabel: 'S3',
    defaultPrice: {
      id: 'price_s3',
      active: true,
      currency: 'usd',
      unitAmount: 1000,
      interval: 'month',
      intervalCount: 1,
      billingScheme: 'per_unit',
      taxBehavior: 'exclusive',
    },
    verification: { ok: true, failures: [] },
    tierId: S3_ID,
  })
})

test('serializeProduct reports a product with no default price and an unbound one', () => {
  const bare = providerProduct({ id: 'prod_bare', name: 'Bare', metadata: {}, suggestedLabel: null, defaultPrice: null })
  const out = serializeProduct(bare, verification(bare, ['product has no default price; set one in the Dashboard']), null)
  assertEquals(out.defaultPrice, null)
  assertEquals(out.suggestedLabel, null)
  assertEquals(out.tierId, null)
  assertEquals(out.verification, { ok: false, failures: ['product has no default price; set one in the Dashboard'] })
  // The failures are copied, not shared with the caller's array.
  const failures = ['x']
  const copied = serializeProduct(bare, { ok: false, product: bare, failures }, null)
  failures.push('y')
  assertEquals(copied.verification.failures, ['x'])
})
