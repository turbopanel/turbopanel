/**
 * The self-hosted grant: parsing, the `SX` row it points at, and the
 * grow-on-self-hosted / shrink-only-on-hosted rule that is the whole
 * difference between the two runtimes.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import { license, payer, setting, subscription, subscriptionItem, tier } from '../db/schema.ts'
import { listSeatsForOrganization } from '../db/billing-records.ts'
import { createMemoryDb, type MemoryDb } from '../../test-fixtures/memory-db.ts'
import { tierQuantitiesFromState } from './assignment-records.ts'
import { CUSTOM_TIER_LABEL } from './ladder.ts'
import {
  parseSelfHostedGrant,
  SELF_HOSTED_GRANT_VERSION,
  selfHostedGrantKey,
  selfHostedGrantRank,
} from './self-hosted-grant.ts'
import {
  ensureCustomTierRow,
  readSelfHostedGrant,
  syncSelfHostedGrant,
} from './self-hosted-grant-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const PAYER = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const SUB = '6ba7b812-9dad-11d1-80b4-00c04fd430c8'
const TIER_S3 = '6ba7b813-9dad-11d1-80b4-00c04fd430c8'
const TIER_SX = '6ba7b814-9dad-11d1-80b4-00c04fd430c8'
const NOW = '2026-01-01T00:00:00.000Z'

function tierRow(id: string, label: string, rank: number) {
  return {
    id,
    label,
    rank,
    provider: 'stripe',
    providerProductId: label === CUSTOM_TIER_LABEL ? null : `prod_${label}`,
    priceCents: null,
    currency: null,
    isCustom: label === CUSTOM_TIER_LABEL,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function licenseRow(id: string, revoked = false) {
  return {
    id,
    organizationId: ORG,
    serverId: null,
    name: null,
    token: 'hash',
    revokedAt: revoked ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function grantDb(opts: {
  tiers?: ReturnType<typeof tierRow>[]
  licenses?: ReturnType<typeof licenseRow>[]
  settings?: { key: string; value: unknown }[]
  /** Provider seats, which the grant target is net of. */
  seats?: { tierId: string; quantity: number }[]
} = {}): MemoryDb {
  const seats = opts.seats ?? []
  return createMemoryDb([
    [tier, opts.tiers ?? [tierRow(TIER_SX, CUSTOM_TIER_LABEL, selfHostedGrantRank())]],
    [
      payer,
      seats.length === 0 ? [] : [{
        id: PAYER,
        organizationId: ORG,
        userId: null,
        provider: 'stripe',
        providerCustomerId: 'cus_1',
        taxId: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    ],
    [
      subscription,
      seats.length === 0 ? [] : [{
        id: SUB,
        payerId: PAYER,
        providerSubscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: null,
        scheduleId: null,
        graceExpiresAt: null,
        pastDueSince: null,
        createdAt: NOW,
        updatedAt: NOW,
      }],
    ],
    [
      subscriptionItem,
      seats.map((seat, index) => ({
        id: `seat-${index}`,
        subscriptionId: SUB,
        tierId: seat.tierId,
        providerItemId: `si_${index}`,
        providerPriceId: `price_${index}`,
        quantity: seat.quantity,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    ],
    [license, opts.licenses ?? []],
    [setting, (opts.settings ?? []).map((row, index) => ({
      id: `setting-${index}`,
      key: row.key,
      value: row.value,
      createdAt: NOW,
      updatedAt: NOW,
    }))],
  ])
}

function storedGrant(quantity: number, tierId = TIER_SX) {
  return {
    key: selfHostedGrantKey(ORG),
    value: { version: SELF_HOSTED_GRANT_VERSION, tierId, quantity },
  }
}

test('parseSelfHostedGrant refuses anything that is not this version of a grant', () => {
  assertEquals(parseSelfHostedGrant(null), null)
  assertEquals(parseSelfHostedGrant([]), null)
  assertEquals(parseSelfHostedGrant({ version: 99, tierId: TIER_SX, quantity: 1 }), null)
  assertEquals(parseSelfHostedGrant({ version: 1, tierId: '', quantity: 1 }), null)
  assertEquals(parseSelfHostedGrant({ version: 1, tierId: TIER_SX, quantity: 'two' }), null)
  // A zero quantity is not a grant — `writeSelfHostedGrant` deletes the row.
  assertEquals(parseSelfHostedGrant({ version: 1, tierId: TIER_SX, quantity: 0 }), null)
  assertEquals(parseSelfHostedGrant({ version: 1, tierId: TIER_SX, quantity: 2.7 }), {
    version: 1,
    tierId: TIER_SX,
    quantity: 2,
  })
})

test('the grant assigns at SX, the top of the ladder', () => {
  assertEquals(selfHostedGrantRank(), 8)
})

test('ensureCustomTierRow returns the existing SX row and creates one when the catalogue is empty', async () => {
  const seeded = grantDb()
  assertEquals(await ensureCustomTierRow(seeded), TIER_SX)

  const empty = grantDb({ tiers: [] })
  const created = await ensureCustomTierRow(empty)
  assertNotEquals(created, '')
  const rows = empty.rows<{ label: string; rank: number; providerProductId: string | null; isCustom: boolean }>(tier)
  assertEquals(rows.length, 1)
  assertEquals(
    [rows[0]?.label, rows[0]?.rank, rows[0]?.providerProductId, rows[0]?.isCustom],
    [CUSTOM_TIER_LABEL, selfHostedGrantRank(), null, true],
  )
})

test('self-hosted grants one SX unit per active license, ignoring revoked ones', async () => {
  const db = grantDb({ licenses: [licenseRow('l1'), licenseRow('l2'), licenseRow('l3', true)] })
  assertEquals(await syncSelfHostedGrant(db, ORG, { allowGrow: true }), {
    version: SELF_HOSTED_GRANT_VERSION,
    tierId: TIER_SX,
    quantity: 2,
  })
  assertEquals((await readSelfHostedGrant(db, ORG))?.quantity, 2)
})

test('the hosted runtime never grows a grant — an unentitled license stays unentitled', async () => {
  const db = grantDb({ licenses: [licenseRow('l1')] })
  assertEquals(await syncSelfHostedGrant(db, ORG, { allowGrow: false }), null)
  assertEquals(await readSelfHostedGrant(db, ORG), null)
})

test('an organization with no grant that may not grow one costs a single setting read', async () => {
  const db = grantDb({ licenses: [licenseRow('l1')] })
  assertEquals(await syncSelfHostedGrant(db, ORG, { allowGrow: false }), null)
  assertEquals(db.ops, ['select:setting'])
})

test('the hosted runtime does shrink a grant, so a revoked license gives its granted unit back', async () => {
  const db = grantDb({ licenses: [licenseRow('l1')], settings: [storedGrant(3)] })
  assertEquals((await syncSelfHostedGrant(db, ORG, { allowGrow: false }))?.quantity, 1)
})

test('the grant covers only what the provider does not: purchased seats come off the target', async () => {
  const db = grantDb({
    licenses: [licenseRow('l1'), licenseRow('l2'), licenseRow('l3')],
    seats: [{ tierId: TIER_S3, quantity: 2 }],
    tiers: [tierRow(TIER_S3, 'S3', 3), tierRow(TIER_SX, CUSTOM_TIER_LABEL, selfHostedGrantRank())],
  })
  assertEquals((await syncSelfHostedGrant(db, ORG, { allowGrow: true }))?.quantity, 1)
})

test('a grant whose licenses are all gone is deleted rather than left at zero', async () => {
  const db = grantDb({ licenses: [licenseRow('l1', true)], settings: [storedGrant(1)] })
  assertEquals(await syncSelfHostedGrant(db, ORG, { allowGrow: true }), null)
  assertEquals(db.rows(setting).length, 0)
})

test('syncing an unchanged grant writes nothing', async () => {
  const db = grantDb({ licenses: [licenseRow('l1')], settings: [storedGrant(1)] })
  assertEquals((await syncSelfHostedGrant(db, ORG, { allowGrow: true }))?.quantity, 1)
  assertEquals(db.ops.filter((op) => !op.startsWith('select:')), [])
})

test('the grant reaches the assignment as an SX quantity that no subscription status can end', async () => {
  const db = grantDb({ licenses: [licenseRow('l1'), licenseRow('l2')], settings: [storedGrant(2)] })
  const state = await listSeatsForOrganization(db, ORG)
  assertEquals(state.grant, { version: SELF_HOSTED_GRANT_VERSION, tierId: TIER_SX, quantity: 2 })
  // No payer, therefore no subscription — the seat side reads as ended, and
  // the grant is still counted.
  assertEquals(tierQuantitiesFromState(state), [
    { tierId: TIER_SX, rank: selfHostedGrantRank(), quantity: 2 },
  ])
})

test('a Deno-minted grant cannot become a free hosted license across a revoke', async () => {
  // Three keys minted while self-hosted, so the grant stands at three.
  const db = grantDb({
    licenses: [licenseRow('l1'), licenseRow('l2'), licenseRow('l3')],
    settings: [storedGrant(3)],
  })
  assertEquals((await syncSelfHostedGrant(db, ORG, { allowGrow: true }))?.quantity, 3)

  // Switched to the hosted runtime; one unbound key is revoked. The grant has
  // to follow it down, or the mint gate would read one license as available
  // and hand out a fourth for nothing.
  db.rows<{ id: string; revokedAt: string | null }>(license)
    .filter((row) => row.id === 'l3')
    .forEach((row) => {
      row.revokedAt = NOW
    })
  assertEquals((await syncSelfHostedGrant(db, ORG, { allowGrow: false }))?.quantity, 2)
})
