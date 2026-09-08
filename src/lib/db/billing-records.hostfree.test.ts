/**
 * Host-free coverage for the billing projection helpers: upsert conflict
 * targets, item replace / prune, unknown-price skip.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { payer, subscription, subscriptionItem, tier } from './schema.ts'
import {
  getPayerForOrganization,
  getSubscriptionForPayer,
  listSubscriptionItems,
  mapProviderPricesToTierIds,
  parseSubscriptionStatus,
  type PayerRow,
  replaceSubscriptionItems,
  type SubscriptionItemRow,
  type SubscriptionRow,
  upsertPayer,
  upsertSubscriptionFromProvider,
} from './billing-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const TIER_S1 = '11111111-1111-4111-8111-111111111111'
const TIER_S2 = '22222222-2222-4222-8222-222222222222'
const SUB_ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

type Insert = { table: unknown; values: Record<string, unknown>; conflict: { target: unknown; set?: unknown } | null }
type Delete = { table: unknown; where: unknown }

type RecordingDb = Db & { inserts: Insert[]; deletes: Delete[]; selectsFrom: unknown[]; ops: string[] }

function tableName(table: unknown): string {
  if (table === payer) return 'payer'
  if (table === subscription) return 'subscription'
  if (table === subscriptionItem) return 'seat'
  if (table === tier) return 'tier'
  return 'unknown'
}

/** Flatten a drizzle SQL object to the text of its chunks plus bound params. */
function flattenSql(query: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    // `notInArray` embeds a bare JS array of params in `queryChunks`.
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const obj = node as Record<string, unknown>
    if ('encoder' in obj) {
      parts.push(Array.isArray(obj.value) ? `[${obj.value.join(',')}]` : String(obj.value))
      return
    }
    if ('name' in obj && 'table' in obj && typeof obj.name === 'string') {
      parts.push(String(obj.name))
      return
    }
    if (Array.isArray(obj.queryChunks)) for (const chunk of obj.queryChunks) visit(chunk)
    if (Array.isArray(obj.value)) for (const chunk of obj.value) visit(chunk)
  }
  visit(query)
  return parts.join('')
}

function createRecordingDb(opts: {
  tiers?: { id: string; providerPriceId: string | null }[]
  rows?: unknown[]
} = {}): RecordingDb {
  const inserts: Insert[] = []
  const deletes: Delete[] = []
  const selectsFrom: unknown[] = []
  /** Every write in call order, so ordering can be asserted. */
  const ops: string[] = []
  const db = {
    inserts,
    deletes,
    selectsFrom,
    ops,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const record: Insert = { table, values, conflict: null }
        inserts.push(record)
        ops.push(`insert:${tableName(table)}`)
        const returning = () => Promise.resolve([{ id: `${tableName(table)}-row` }])
        const chain = {
          onConflictDoUpdate: (conflict: { target: unknown; set?: unknown }) => {
            record.conflict = conflict
            const p = Promise.resolve(undefined)
            return Object.assign(p, { returning })
          },
          returning,
        }
        return chain
      },
    }),
    select: () => ({
      from: (table: unknown) => {
        selectsFrom.push(table)
        const rows = table === tier ? (opts.tiers ?? []) : (opts.rows ?? [])
        const thenable = {
          then: (onF: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
            Promise.resolve(rows).then(onF, onR),
          limit: () => Promise.resolve(rows.slice(0, 1)),
          orderBy: () => ({
            limit: () => Promise.resolve(rows.slice(0, 1)),
            then: (onF: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
              Promise.resolve(rows).then(onF, onR),
          }),
        }
        return { where: () => thenable }
      },
    }),
    delete: (table: unknown) => ({
      where: (where: unknown) => {
        deletes.push({ table, where })
        ops.push(`delete:${tableName(table)}`)
        return Promise.resolve(undefined)
      },
    }),
  }
  return db as unknown as RecordingDb
}

test('upsertPayer conflicts on (provider, provider_customer_id) and writes the subject on insert only', async () => {
  const db = createRecordingDb()
  const result = await upsertPayer(db, {
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    subject: { organizationId: ORG_ID, userId: null },
    taxId: 'DE123',
    now: '2026-09-07T00:00:00.000Z',
  })
  assertEquals(result, { id: 'payer-row' })
  const [insert] = db.inserts
  assertEquals(tableName(insert?.table), 'payer')
  assertEquals(insert?.values.organizationId, ORG_ID)
  assertEquals(insert?.values.userId, null)
  assertEquals(insert?.values.providerCustomerId, 'cus_1')
  assertEquals(insert?.conflict?.target, [payer.provider, payer.providerCustomerId])
  // The subject is not part of the update set: a customer is never re-homed.
  const set = insert?.conflict?.set as Record<string, unknown>
  assertEquals(Object.keys(set).sort(), ['taxId', 'updatedAt'])
})

test('upsertSubscriptionFromProvider conflicts on provider_subscription_id and latches past_due_since', async () => {
  const db = createRecordingDb()
  await upsertSubscriptionFromProvider(db, {
    payerId: 'payer-row',
    providerSubscriptionId: 'sub_1',
    status: 'past_due',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    scheduleId: null,
    now: '2026-09-07T00:00:00.000Z',
  })
  const [pastDue] = db.inserts
  assertEquals(tableName(pastDue?.table), 'subscription')
  assertEquals(pastDue?.conflict?.target, subscription.providerSubscriptionId)
  assertEquals(pastDue?.values.pastDueSince, '2026-09-07T00:00:00.000Z')
  const set = pastDue?.conflict?.set as Record<string, unknown>
  // On conflict the latch keeps the earlier moment: coalesce(existing, now).
  assertEquals(flattenSql(set.pastDueSince).includes('coalesce('), true)
  assertEquals(set.status, 'past_due')

  await upsertSubscriptionFromProvider(db, {
    payerId: 'payer-row',
    providerSubscriptionId: 'sub_1',
    status: 'active',
    currentPeriodEnd: null,
    scheduleId: 'sub_sched_1',
  })
  const active = db.inserts[1]
  assertEquals(active?.values.pastDueSince, null)
  assertEquals((active?.conflict?.set as Record<string, unknown>).pastDueSince, null)
  assertEquals((active?.conflict?.set as Record<string, unknown>).scheduleId, 'sub_sched_1')
})

test('replaceSubscriptionItems clears the subscription first, then inserts every mappable item', async () => {
  const db = createRecordingDb({
    tiers: [
      { id: TIER_S1, providerPriceId: 'price_s1' },
      { id: TIER_S2, providerPriceId: 'price_s2' },
    ],
  })
  const result = await replaceSubscriptionItems(db, SUB_ROW, [
    { providerItemId: 'si_1', providerPriceId: 'price_s1', quantity: 3 },
    { providerItemId: 'si_2', providerPriceId: 'price_s2', quantity: 1 },
  ], { now: '2026-09-07T00:00:00.000Z' })
  assertEquals(result, { written: 2, skipped: [] })
  // Order is the point: the prune must land before the first insert, or a
  // replaced item at the same tier trips `uniq_seat_subscription_tier`.
  assertEquals(db.ops, ['delete:seat', 'insert:seat', 'insert:seat'])
  assertEquals(db.inserts[0]?.values.tierId, TIER_S1)
  assertEquals(db.inserts[0]?.values.quantity, 3)
  assertEquals(db.inserts[0]?.conflict?.target, subscriptionItem.providerItemId)
  assertEquals(db.inserts[1]?.values.tierId, TIER_S2)
  // The prune is scoped to the subscription and nothing else.
  assertEquals(db.deletes.length, 1)
  assertEquals(tableName(db.deletes[0]?.table), 'seat')
  const prune = flattenSql(db.deletes[0]?.where)
  assertEquals(prune.includes(SUB_ROW), true)
  assertEquals(prune.includes('not in'), false)
})

test('an item whose price maps to no tier is skipped, never inserted with a null tier', async () => {
  const db = createRecordingDb({ tiers: [{ id: TIER_S1, providerPriceId: 'price_s1' }] })
  const result = await replaceSubscriptionItems(db, SUB_ROW, [
    { providerItemId: 'si_known', providerPriceId: 'price_s1', quantity: 2 },
    { providerItemId: 'si_unknown', providerPriceId: 'price_nope', quantity: 5 },
    { providerItemId: 'si_bad_qty', providerPriceId: 'price_s1', quantity: -1 },
  ])
  assertEquals(result, { written: 1, skipped: ['si_unknown', 'si_bad_qty'] })
  assertEquals(db.inserts.length, 1)
  assertEquals(db.inserts[0]?.values.providerItemId, 'si_known')
  assertEquals(db.inserts.every((i) => i.values.tierId !== null), true)
  // The prune ran first and covered the whole subscription, so a stale row
  // for the skipped item is gone too.
  assertEquals(db.ops[0], 'delete:seat')
})

test('an empty item list prunes every seat of the subscription and inserts nothing', async () => {
  const db = createRecordingDb()
  const result = await replaceSubscriptionItems(db, SUB_ROW, [])
  assertEquals(result, { written: 0, skipped: [] })
  assertEquals(db.inserts.length, 0)
  // No tier lookup for an empty price list.
  assertEquals(db.selectsFrom.length, 0)
  assertEquals(db.ops, ['delete:seat'])
  const prune = flattenSql(db.deletes[0]?.where)
  assertEquals(prune.includes(SUB_ROW), true)
})

test('mapProviderPricesToTierIds dedupes, drops blanks, and omits unknown prices', async () => {
  const db = createRecordingDb({ tiers: [{ id: TIER_S1, providerPriceId: 'price_s1' }] })
  const map = await mapProviderPricesToTierIds(db, ['price_s1', 'price_s1', '', 'price_x'])
  assertEquals([...map.entries()], [['price_s1', TIER_S1]])
  assertEquals(await mapProviderPricesToTierIds(db, []), new Map())
})

test('read helpers return the row or null', async () => {
  const row: PayerRow = {
    id: 'p1',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    organizationId: ORG_ID,
    userId: null,
    provider: 'stripe',
    providerCustomerId: 'cus_1',
    taxId: null,
  }
  assertEquals(await getPayerForOrganization(createRecordingDb({ rows: [row] }), ORG_ID), row)
  assertEquals(await getPayerForOrganization(createRecordingDb(), ORG_ID), null)
  const sub: SubscriptionRow = {
    id: 's1',
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    payerId: 'p1',
    providerSubscriptionId: 'sub_1',
    status: 'active',
    currentPeriodEnd: null,
    scheduleId: null,
    graceExpiresAt: null,
    pastDueSince: null,
  }
  assertEquals(await getSubscriptionForPayer(createRecordingDb({ rows: [sub] }), 'p1'), sub)
  assertEquals(await getSubscriptionForPayer(createRecordingDb(), 'p1'), null)
  const items: SubscriptionItemRow[] = [
    {
      id: 'i1',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z',
      subscriptionId: 's1',
      tierId: TIER_S1,
      providerItemId: 'si_1',
      quantity: 2,
    },
  ]
  assertEquals(await listSubscriptionItems(createRecordingDb({ rows: items }), 's1'), items)
})

test('parseSubscriptionStatus narrows known values and never throws on new ones', () => {
  assertEquals(parseSubscriptionStatus('active'), 'active')
  assertEquals(parseSubscriptionStatus('past_due'), 'past_due')
  // No CHECK on the column: a status Stripe adds tomorrow is stored verbatim
  // and read back as `unknown`, not as a 500.
  assertEquals(parseSubscriptionStatus('some_new_stripe_status'), 'unknown')
})

// ---------------------------------------------------------------------------
// `applySeatEntitlements` — the one place `license.tier_id` moves for billing.
// ---------------------------------------------------------------------------

import { license, setting } from './schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import {
  applySeatEntitlements,
  BILLING_GRACE_WINDOW_MS,
  isDelinquentStatus,
  isEndedStatus,
  KNOWN_SUBSCRIPTION_STATUSES,
  listSeatsForOrganization,
  seatQuantitiesByTier,
} from './billing-records.ts'

const PAYER_ROW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LIC_BOUND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LIC_FREE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const LIC_FREE_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const ENT_NOW = '2026-09-07T12:00:00.000Z'

const entTier = (id: string, label: string, rank: number) => ({
  id, label, generation: 1, rank, priceCents: 1000 * rank, providerPriceId: `price_${label}`, isCustom: false, isActive: true,
  successorId: null, maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1, createdAt: ENT_NOW, updatedAt: ENT_NOW,
})
const entLicense = (id: string, tierId: string, serverId: string | null) => ({
  id, organizationId: ORG_ID, serverId, tierId, name: null, token: 'x', revokedAt: null, createdAt: ENT_NOW, updatedAt: ENT_NOW,
})

function entitlementDb(opts: {
  status?: string
  seats: { tierId: string; quantity: number }[]
  licenses: { id: string; tierId: string; serverId: string | null }[]
}) {
  return createMemoryDb([
    [tier, [entTier(TIER_S1, 'S1', 1), entTier(TIER_S2, 'S2', 2)]],
    [payer, [{ id: PAYER_ROW, organizationId: ORG_ID, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: ENT_NOW, updatedAt: ENT_NOW }]],
    [subscription, [{ id: SUB_ROW, payerId: PAYER_ROW, providerSubscriptionId: 'sub_1', status: opts.status ?? 'active', currentPeriodEnd: null, scheduleId: null, graceExpiresAt: null, pastDueSince: null, createdAt: ENT_NOW, updatedAt: ENT_NOW }]],
    [subscriptionItem, opts.seats.map((seat, index) => ({ id: `seat-${index}`, subscriptionId: SUB_ROW, tierId: seat.tierId, providerItemId: `si_${index}`, quantity: seat.quantity, createdAt: ENT_NOW, updatedAt: ENT_NOW }))],
    [license, opts.licenses.map((l) => entLicense(l.id, l.tierId, l.serverId))],
    [setting, []],
  ])
}

const licenseTier = (db: ReturnType<typeof entitlementDb>, id: string) =>
  db.rows(license).find((row) => row.id === id)

test('listSeatsForOrganization joins payer → subscription → seats with their tier, in catalogue order', async () => {
  const db = entitlementDb({ seats: [{ tierId: TIER_S2, quantity: 1 }, { tierId: TIER_S1, quantity: 3 }], licenses: [] })
  const state = await listSeatsForOrganization(db, ORG_ID)
  assertEquals(state.subscription?.providerSubscriptionId, 'sub_1')
  assertEquals(state.seats.map((seat) => [seat.tier.label, seat.quantity]), [['S1', 3], ['S2', 1]])
  assertEquals([...seatQuantitiesByTier(state)], [[TIER_S1, 3], [TIER_S2, 1]])
  assertEquals(await listSeatsForOrganization(db, '00000000-0000-4000-8000-000000000000'), { payer: null, subscription: null, seats: [] })
})

test('applySeatEntitlements repoints exactly the intended license once the target tier has room', async () => {
  // Upgrade of the bound license S1 → S2 landed: S1 seats 1, S2 seats 1.
  const db = entitlementDb({
    seats: [{ tierId: TIER_S1, quantity: 1 }, { tierId: TIER_S2, quantity: 1 }],
    licenses: [{ id: LIC_BOUND, tierId: TIER_S1, serverId: SERVER_A }, { id: LIC_FREE, tierId: TIER_S1, serverId: null }],
  })
  const intent = { id: 'i1', kind: 'upgrade' as const, licenseId: LIC_BOUND, fromTierId: TIER_S1, toTierId: TIER_S2 }
  const result = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW })
  assertEquals(result.consumedIntentIds, ['i1'])
  assertEquals(result.repointed, [{ licenseId: LIC_BOUND, fromTierId: TIER_S1, toTierId: TIER_S2 }])
  assertEquals(result.revokedLicenseIds, [])
  assertEquals(result.drift, [])
  // The bound license moved; the unbound one at S1 was not touched.
  assertEquals(licenseTier(db, LIC_BOUND)?.tierId, TIER_S2)
  assertEquals(licenseTier(db, LIC_FREE)?.tierId, TIER_S1)
})

test('applySeatEntitlements leaves an upgrade intent alone while the change is pending or not yet committed', async () => {
  // Committed items still show the old shape: S1 2, S2 0.
  const db = entitlementDb({
    seats: [{ tierId: TIER_S1, quantity: 2 }],
    licenses: [{ id: LIC_BOUND, tierId: TIER_S1, serverId: SERVER_A }, { id: LIC_FREE, tierId: TIER_S1, serverId: null }],
  })
  const intent = { id: 'i1', kind: 'upgrade' as const, licenseId: LIC_BOUND, fromTierId: TIER_S1, toTierId: TIER_S2 }
  const replay = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW })
  assertEquals(replay.consumedIntentIds, [])
  assertEquals(replay.repointed, [])
  // Even with room at the target, a `pending_update` on the subscription holds it back.
  db.rows(subscriptionItem).push({ id: 'seat-x', subscriptionId: SUB_ROW, tierId: TIER_S2, providerItemId: 'si_x', quantity: 1, createdAt: ENT_NOW, updatedAt: ENT_NOW })
  const pending = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW, pendingUpdate: true })
  assertEquals(pending.consumedIntentIds, [])
  assertEquals(licenseTier(db, LIC_BOUND)?.tierId, TIER_S1)
})

test('applySeatEntitlements closes a residual gap with unbound licenses only and reports the bound remainder as drift', async () => {
  // Seats dropped to 1 at S1 with three licenses there: one bound, two free.
  const db = entitlementDb({
    seats: [{ tierId: TIER_S1, quantity: 1 }],
    licenses: [
      { id: LIC_BOUND, tierId: TIER_S1, serverId: SERVER_A },
      { id: LIC_FREE, tierId: TIER_S1, serverId: null },
      { id: LIC_FREE_2, tierId: TIER_S1, serverId: null },
    ],
  })
  const result = await applySeatEntitlements(db, ORG_ID, [], { now: ENT_NOW })
  assertEquals(result.revokedLicenseIds.sort(), [LIC_FREE, LIC_FREE_2].sort())
  assertEquals(result.drift, [])
  assertEquals(licenseTier(db, LIC_BOUND)?.revokedAt, null)

  // Now seats go to 0 while the subscription is still live: the bound license is never touched.
  db.rows(subscriptionItem)[0]!.quantity = 0
  const short = await applySeatEntitlements(db, ORG_ID, [], { now: ENT_NOW })
  assertEquals(short.revokedLicenseIds, [])
  assertEquals(short.drift, [{ tierId: TIER_S1, seats: 0, active: 1, bound: 1, excess: 1 }])
  assertEquals(licenseTier(db, LIC_BOUND)?.revokedAt, null)
})

test('applySeatEntitlements repoints an excess unbound license DOWN into a free seat, never up', async () => {
  // S2 lost its seat; S1 has a spare: the unbound S2 license moves down.
  const down = entitlementDb({
    seats: [{ tierId: TIER_S2, quantity: 0 }, { tierId: TIER_S1, quantity: 1 }],
    licenses: [{ id: LIC_FREE, tierId: TIER_S2, serverId: null }],
  })
  const moved = await applySeatEntitlements(down, ORG_ID, [], { now: ENT_NOW })
  assertEquals(moved.repointed, [{ licenseId: LIC_FREE, fromTierId: TIER_S2, toTierId: TIER_S1 }])
  assertEquals(moved.revokedLicenseIds, [])
  // The mirror: a spare S2 seat is not a reason to hand an S1 license S2 entitlements.
  const up = entitlementDb({
    seats: [{ tierId: TIER_S1, quantity: 0 }, { tierId: TIER_S2, quantity: 1 }],
    licenses: [{ id: LIC_FREE, tierId: TIER_S1, serverId: null }],
  })
  const revoked = await applySeatEntitlements(up, ORG_ID, [], { now: ENT_NOW })
  assertEquals(revoked.repointed, [])
  assertEquals(revoked.revokedLicenseIds, [LIC_FREE])
})

test('applySeatEntitlements consumes a release-seat intent when the source tier quantity has dropped', async () => {
  // The revoked key already left `license`; the seat still counts until the boundary.
  const db = entitlementDb({
    seats: [{ tierId: TIER_S1, quantity: 2 }],
    licenses: [{ id: LIC_BOUND, tierId: TIER_S1, serverId: SERVER_A }],
  })
  const intent = { id: 'r1', kind: 'release-seat' as const, licenseId: LIC_FREE, fromTierId: TIER_S1, toTierId: null }
  const before = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW })
  assertEquals(before.consumedIntentIds, [])
  db.rows(subscriptionItem)[0]!.quantity = 1
  const after = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW })
  assertEquals(after.consumedIntentIds, ['r1'])
  assertEquals(after.drift, [])
  assertEquals(after.revokedLicenseIds, [])
})

test('applySeatEntitlements consumes a downgrade only once the source is short and the target has room', async () => {
  const db = entitlementDb({
    seats: [{ tierId: TIER_S2, quantity: 1 }],
    licenses: [{ id: LIC_BOUND, tierId: TIER_S2, serverId: SERVER_A }],
  })
  const intent = { id: 'd1', kind: 'downgrade' as const, licenseId: LIC_BOUND, fromTierId: TIER_S2, toTierId: TIER_S1 }
  const early = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW })
  assertEquals(early.consumedIntentIds, [])
  // The boundary landed: S2 0, S1 1.
  db.rows(subscriptionItem)[0]!.quantity = 0
  db.rows(subscriptionItem).push({ id: 'seat-s1', subscriptionId: SUB_ROW, tierId: TIER_S1, providerItemId: 'si_s1', quantity: 1, createdAt: ENT_NOW, updatedAt: ENT_NOW })
  const landed = await applySeatEntitlements(db, ORG_ID, [intent], { now: ENT_NOW })
  assertEquals(landed.consumedIntentIds, ['d1'])
  assertEquals(landed.repointed, [{ licenseId: LIC_BOUND, fromTierId: TIER_S2, toTierId: TIER_S1 }])
  assertEquals(landed.drift, [])
})

test('an ended subscription revokes bound licenses too, through the revoke-bound hook', async () => {
  const db = entitlementDb({
    status: 'canceled',
    seats: [{ tierId: TIER_S1, quantity: 2 }],
    licenses: [{ id: LIC_BOUND, tierId: TIER_S1, serverId: SERVER_A }, { id: LIC_FREE, tierId: TIER_S1, serverId: null }],
  })
  const disconnected: string[] = []
  const result = await applySeatEntitlements(db, ORG_ID, [], {
    now: ENT_NOW,
    onRevokeBound: (serverId) => Promise.resolve(disconnected.push(serverId)).then(() => {}),
  })
  assertEquals(result.revokedLicenseIds.sort(), [LIC_BOUND, LIC_FREE].sort())
  assertEquals(result.disconnectedServerIds, [SERVER_A])
  assertEquals(disconnected, [SERVER_A])
  assertEquals(result.drift, [])
  assertEquals(db.rows(license).every((row) => row.revokedAt === ENT_NOW), true)
})

// ---------------------------------------------------------------------------
// T8 · status semantics, one table over every known status plus one unknown.
// ---------------------------------------------------------------------------

const EVERY_STATUS = [...KNOWN_SUBSCRIPTION_STATUSES, 'some_future_status'] as const
const DELINQUENT = ['past_due', 'unpaid']
const ENDED = ['canceled', 'incomplete_expired']

test('T8 · delinquent and ended are disjoint, exact, and closed to statuses Stripe adds later', () => {
  for (const status of EVERY_STATUS) {
    assertEquals(isDelinquentStatus(status), DELINQUENT.includes(status), status)
    assertEquals(isEndedStatus(status), ENDED.includes(status), status)
  }
})

test('T8 · committed seats read as zero under an ended status and as counted under every other, trialing and paused included', async () => {
  for (const status of EVERY_STATUS) {
    const db = entitlementDb({ status, seats: [{ tierId: TIER_S1, quantity: 2 }], licenses: [] })
    const state = await listSeatsForOrganization(db, ORG_ID)
    assertEquals(seatQuantitiesByTier(state).get(TIER_S1), ENDED.includes(status) ? 0 : 2, status)
  }
})

test('T8 · incomplete_expired revokes like canceled — bound licenses included — while trialing, paused and the delinquent statuses revoke nothing', async () => {
  const licenses = [{ id: LIC_BOUND, tierId: TIER_S1, serverId: SERVER_A }, { id: LIC_FREE, tierId: TIER_S1, serverId: null }]
  {
    const db = entitlementDb({ status: 'incomplete_expired', seats: [{ tierId: TIER_S1, quantity: 2 }], licenses })
    const disconnected: string[] = []
    const result = await applySeatEntitlements(db, ORG_ID, [], {
      now: ENT_NOW,
      onRevokeBound: (serverId) => Promise.resolve(disconnected.push(serverId)).then(() => {}),
    })
    assertEquals(result.revokedLicenseIds.sort(), [LIC_BOUND, LIC_FREE].sort())
    assertEquals(result.disconnectedServerIds, [SERVER_A])
    assertEquals(disconnected, [SERVER_A])
    assertEquals(db.rows(license).every((row) => row.revokedAt === ENT_NOW), true)
  }
  for (const status of ['trialing', 'paused', 'past_due', 'unpaid', 'incomplete', 'some_future_status']) {
    const db = entitlementDb({ status, seats: [{ tierId: TIER_S1, quantity: 2 }], licenses })
    const result = await applySeatEntitlements(db, ORG_ID, [], {
      now: ENT_NOW,
      onRevokeBound: () => Promise.reject(new Error(`revoked a bound license under ${status}`)),
    })
    assertEquals(result.revokedLicenseIds, [], status)
    assertEquals(result.repointed, [], status)
    assertEquals(result.drift, [], status)
    assertEquals(db.rows(license).every((row) => row.revokedAt === null), true, status)
  }
})

test('T8 · the past-due latch and the 65-day grace deadline are set for the delinquent statuses only', async () => {
  const now = '2026-09-07T00:00:00.000Z'
  assertEquals(BILLING_GRACE_WINDOW_MS, 65 * 24 * 60 * 60 * 1000)
  const deadline = new Date(Date.parse(now) + BILLING_GRACE_WINDOW_MS).toISOString()
  for (const status of EVERY_STATUS) {
    const db = createRecordingDb()
    await upsertSubscriptionFromProvider(db, { payerId: 'payer-row', providerSubscriptionId: 'sub_1', status, currentPeriodEnd: null, scheduleId: null, now })
    const [insert] = db.inserts
    const set = insert?.conflict?.set as Record<string, unknown>
    if (DELINQUENT.includes(status)) {
      assertEquals(insert?.values.pastDueSince, now, status)
      assertEquals(insert?.values.graceExpiresAt, deadline, status)
      // On conflict both latch: the earlier moment wins.
      assertEquals(flattenSql(set.pastDueSince).includes('coalesce('), true, status)
      assertEquals(flattenSql(set.graceExpiresAt).includes('coalesce('), true, status)
    } else {
      assertEquals(insert?.values.pastDueSince, null, status)
      assertEquals(insert?.values.graceExpiresAt, null, status)
      assertEquals(set.pastDueSince, null, status)
      assertEquals(set.graceExpiresAt, null, status)
    }
  }
})
