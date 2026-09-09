/**
 * Host-free coverage for the billing projection helpers: upsert conflict
 * targets, item replace / prune keyed on the item's **product**, the
 * unmapped-product skip, the two-items-one-tier fold, the organization
 * read every page and sweep uses, and the one revoke billing performs.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { license, payer, setting, subscription, subscriptionItem, tier } from './schema.ts'
import {
  BILLING_GRACE_WINDOW_MS,
  getPayerForOrganization,
  getSubscriptionForPayer,
  isDelinquentStatus,
  isEndedStatus,
  KNOWN_SUBSCRIPTION_STATUSES,
  listSeatsForOrganization,
  listSubscriptionItems,
  parseSubscriptionStatus,
  type PayerRow,
  replaceSubscriptionItems,
  revokeAllLicensesForOrganization,
  seatQuantitiesByTier,
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
  tiers?: { id: string; providerProductId: string | null }[]
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
    taxId: null,
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

test('replaceSubscriptionItems clears the subscription first, then inserts every item whose product maps to a tier', async () => {
  const db = createRecordingDb({
    tiers: [
      { id: TIER_S1, providerProductId: 'prod_s1' },
      { id: TIER_S2, providerProductId: 'prod_s2' },
    ],
  })
  const result = await replaceSubscriptionItems(db, SUB_ROW, [
    { providerItemId: 'si_1', providerPriceId: 'price_s1', providerProductId: 'prod_s1', quantity: 3 },
    { providerItemId: 'si_2', providerPriceId: 'price_s2_v2', providerProductId: 'prod_s2', quantity: 1 },
  ], { now: '2026-09-07T00:00:00.000Z', provider: 'stripe' })
  assertEquals(result, { written: 2, skipped: [] })
  // Order is the point: the prune must land before the first insert, or a
  // replaced item at the same tier trips `uniq_seat_subscription_tier`.
  assertEquals(db.ops, ['delete:seat', 'insert:seat', 'insert:seat'])
  assertEquals(db.inserts[0]?.values.tierId, TIER_S1)
  assertEquals(db.inserts[0]?.values.quantity, 3)
  // The item's own price is written beside the tier: a mutation restates it, and the tier does not know it.
  assertEquals(db.inserts[0]?.values.providerPriceId, 'price_s1')
  assertEquals(db.inserts[0]?.conflict?.target, subscriptionItem.providerItemId)
  assertEquals((db.inserts[0]?.conflict?.set as Record<string, unknown>).providerPriceId, 'price_s1')
  assertEquals(db.inserts[1]?.values.tierId, TIER_S2)
  assertEquals(db.inserts[1]?.values.providerPriceId, 'price_s2_v2')
  // The prune is scoped to the subscription and nothing else.
  assertEquals(db.deletes.length, 1)
  assertEquals(tableName(db.deletes[0]?.table), 'seat')
  const prune = flattenSql(db.deletes[0]?.where)
  assertEquals(prune.includes(SUB_ROW), true)
  assertEquals(prune.includes('not in'), false)
})

test('an item whose product maps to no tier is skipped, never inserted with a null tier', async () => {
  const db = createRecordingDb({ tiers: [{ id: TIER_S1, providerProductId: 'prod_s1' }] })
  const result = await replaceSubscriptionItems(db, SUB_ROW, [
    { providerItemId: 'si_known', providerPriceId: 'price_s1', providerProductId: 'prod_s1', quantity: 2 },
    { providerItemId: 'si_unknown', providerPriceId: 'price_nope', providerProductId: 'prod_nope', quantity: 5 },
    { providerItemId: 'si_bad_qty', providerPriceId: 'price_s1_old', providerProductId: 'prod_s1', quantity: -1 },
  ])
  assertEquals(result, { written: 1, skipped: ['si_unknown', 'si_bad_qty'] })
  assertEquals(db.inserts.length, 1)
  assertEquals(db.inserts[0]?.values.providerItemId, 'si_known')
  assertEquals(db.inserts[0]?.values.quantity, 2)
  assertEquals(db.inserts.every((i) => i.values.tierId !== null), true)
  // The prune ran first and covered the whole subscription, so a stale row
  // for the skipped item is gone too.
  assertEquals(db.ops[0], 'delete:seat')
})

test('two items on one tier are summed under the first item id; the second lands in skipped', async () => {
  const db = createRecordingDb({ tiers: [{ id: TIER_S1, providerProductId: 'prod_s1' }, { id: TIER_S2, providerProductId: 'prod_s2' }] })
  const result = await replaceSubscriptionItems(db, SUB_ROW, [
    { providerItemId: 'si_old_price', providerPriceId: 'price_s1_v1', providerProductId: 'prod_s1', quantity: 2 },
    { providerItemId: 'si_other', providerPriceId: 'price_s2', providerProductId: 'prod_s2', quantity: 1 },
    { providerItemId: 'si_new_price', providerPriceId: 'price_s1_v2', providerProductId: 'prod_s1', quantity: 3 },
  ])
  assertEquals(result, { written: 2, skipped: ['si_new_price'] })
  assertEquals(db.ops, ['delete:seat', 'insert:seat', 'insert:seat'])
  const s1 = db.inserts.find((i) => i.values.tierId === TIER_S1)
  assertEquals([s1?.values.providerItemId, s1?.values.providerPriceId, s1?.values.quantity], ['si_old_price', 'price_s1_v1', 5])
  const s2 = db.inserts.find((i) => i.values.tierId === TIER_S2)
  assertEquals([s2?.values.providerItemId, s2?.values.quantity], ['si_other', 1])
})

test('an empty item list prunes every seat of the subscription and inserts nothing', async () => {
  const db = createRecordingDb()
  const result = await replaceSubscriptionItems(db, SUB_ROW, [])
  assertEquals(result, { written: 0, skipped: [] })
  assertEquals(db.inserts.length, 0)
  // No tier lookup for an empty product list.
  assertEquals(db.selectsFrom.length, 0)
  assertEquals(db.ops, ['delete:seat'])
  const prune = flattenSql(db.deletes[0]?.where)
  assertEquals(prune.includes(SUB_ROW), true)
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
      providerPriceId: 'price_s1',
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
// The organization read and the one revoke billing performs, on the memory db.
// ---------------------------------------------------------------------------

const PAYER_ROW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SERVER_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SERVER_B = '99999999-9999-4999-8999-999999999999'
const LIC_BOUND = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LIC_BOUND_2 = '88888888-8888-4888-8888-888888888888'
const LIC_FREE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const LIC_GONE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const OTHER_ORG = '77777777-7777-4777-8777-777777777777'
const ENT_NOW = '2026-09-07T12:00:00.000Z'
const EARLIER = '2026-09-01T00:00:00.000Z'

const entTier = (id: string, label: string, rank: number, isActive = true) => ({
  id, createdAt: ENT_NOW, updatedAt: ENT_NOW, label, rank, provider: 'stripe', providerProductId: `prod_${label}`,
  priceCents: 1000 * rank, currency: 'usd', isCustom: false, isActive,
})
const entLicense = (id: string, serverId: string | null, overrides: Record<string, unknown> = {}) => ({
  id, organizationId: ORG_ID, serverId, name: null, token: 'x', revokedAt: null, createdAt: ENT_NOW, updatedAt: ENT_NOW, ...overrides,
})

function entitlementDb(opts: {
  status?: string
  seats: { tierId: string; quantity: number; providerPriceId?: string | null }[]
  licenses: ReturnType<typeof entLicense>[]
}) {
  return createMemoryDb([
    [tier, [entTier(TIER_S1, 'S1', 1), entTier(TIER_S2, 'S2', 2, false)]],
    // The self-hosted grant lives in a `setting` row; every entitlement read
    // looks for one (`src/lib/tiers/self-hosted-grant.ts`).
    [setting, []],
    [payer, [{ id: PAYER_ROW, organizationId: ORG_ID, userId: null, provider: 'stripe', providerCustomerId: 'cus_1', taxId: null, createdAt: ENT_NOW, updatedAt: ENT_NOW }]],
    [subscription, [{ id: SUB_ROW, payerId: PAYER_ROW, providerSubscriptionId: 'sub_1', status: opts.status ?? 'active', currentPeriodEnd: null, scheduleId: null, graceExpiresAt: null, pastDueSince: null, createdAt: ENT_NOW, updatedAt: ENT_NOW }]],
    [subscriptionItem, opts.seats.map((seat, index) => ({
      id: `seat-${index}`, subscriptionId: SUB_ROW, tierId: seat.tierId, providerItemId: `si_${index}`,
      providerPriceId: seat.providerPriceId === undefined ? `price_${index}` : seat.providerPriceId,
      quantity: seat.quantity, createdAt: ENT_NOW, updatedAt: ENT_NOW,
    }))],
    [license, opts.licenses],
  ])
}

test('listSeatsForOrganization joins payer → subscription → seats with their tier, in rank order', async () => {
  const db = entitlementDb({ seats: [{ tierId: TIER_S2, quantity: 1 }, { tierId: TIER_S1, quantity: 3, providerPriceId: null }], licenses: [] })
  const state = await listSeatsForOrganization(db, ORG_ID)
  assertEquals(state.payer?.id, PAYER_ROW)
  assertEquals(state.subscription?.providerSubscriptionId, 'sub_1')
  assertEquals(state.seats, [
    {
      seatId: 'seat-1',
      tierId: TIER_S1,
      providerItemId: 'si_1',
      providerPriceId: null,
      quantity: 3,
      tier: { label: 'S1', rank: 1, priceCents: 1000, currency: 'usd', providerProductId: 'prod_S1', isActive: true },
    },
    {
      seatId: 'seat-0',
      tierId: TIER_S2,
      providerItemId: 'si_0',
      providerPriceId: 'price_0',
      quantity: 1,
      // A retired tier is still read: existing seats may hold it, they just cannot buy more.
      tier: { label: 'S2', rank: 2, priceCents: 2000, currency: 'usd', providerProductId: 'prod_S2', isActive: false },
    },
  ])
  assertEquals(await listSeatsForOrganization(db, OTHER_ORG), { payer: null, subscription: null, seats: [], grant: null })
  // A payer with no subscription yet (Checkout not completed) reads as no seats.
  db.rows(subscription).splice(0)
  const early = await listSeatsForOrganization(db, ORG_ID)
  assertEquals([early.payer?.id, early.subscription, early.seats], [PAYER_ROW, null, []])
})

test('seatQuantitiesByTier sums per tier and reads every tier as zero once the subscription ended', async () => {
  const live = entitlementDb({ seats: [{ tierId: TIER_S1, quantity: 3 }, { tierId: TIER_S2, quantity: 1 }, { tierId: TIER_S1, quantity: 2 }], licenses: [] })
  assertEquals([...seatQuantitiesByTier(await listSeatsForOrganization(live, ORG_ID))], [[TIER_S1, 5], [TIER_S2, 1]])
  const ended = entitlementDb({ status: 'canceled', seats: [{ tierId: TIER_S1, quantity: 3 }], licenses: [] })
  assertEquals([...seatQuantitiesByTier(await listSeatsForOrganization(ended, ORG_ID))], [[TIER_S1, 0]])
  assertEquals(seatQuantitiesByTier({ payer: null, subscription: null, seats: [], grant: null }), new Map())
})

test('revokeAllLicensesForOrganization revokes bound and unbound keys, names the bound servers, and leaves other rows alone', async () => {
  const db = entitlementDb({
    seats: [{ tierId: TIER_S1, quantity: 2 }],
    licenses: [
      entLicense(LIC_BOUND, SERVER_A),
      entLicense(LIC_FREE, null),
      entLicense(LIC_BOUND_2, SERVER_B),
      // Already revoked: not touched, not reported, its timestamp kept.
      entLicense(LIC_GONE, null, { revokedAt: EARLIER, updatedAt: EARLIER }),
      // Another organization's key.
      entLicense('other-org-key', 'other-server', { organizationId: OTHER_ORG }),
    ],
  })
  const disconnected: string[] = []
  const result = await revokeAllLicensesForOrganization(db, ORG_ID, {
    now: ENT_NOW,
    onRevokeBound: (serverId) => Promise.resolve(disconnected.push(serverId)).then(() => {}),
  })
  assertEquals(result.licenseIds, [LIC_BOUND, LIC_FREE, LIC_BOUND_2])
  assertEquals(result.serverIds, [SERVER_A, SERVER_B])
  assertEquals(disconnected, [SERVER_A, SERVER_B])
  const byId = new Map(db.rows(license).map((row) => [row.id, row]))
  for (const id of [LIC_BOUND, LIC_FREE, LIC_BOUND_2]) {
    assertEquals([byId.get(id)?.revokedAt, byId.get(id)?.updatedAt], [ENT_NOW, ENT_NOW], id)
  }
  assertEquals(byId.get(LIC_GONE)?.revokedAt, EARLIER)
  assertEquals(byId.get('other-org-key')?.revokedAt, null)
  // Bound rows keep their server id for audit; nothing else is written.
  assertEquals(byId.get(LIC_BOUND)?.serverId, SERVER_A)
  assertEquals(db.ops.filter((op) => op.startsWith('update:')), ['update:license', 'update:license', 'update:license'])
  assertEquals(db.ops.filter((op) => op.startsWith('delete:') || op.startsWith('insert:')), [])

  // A second pass finds nothing to revoke and calls no hook.
  const again = await revokeAllLicensesForOrganization(db, ORG_ID, {
    now: ENT_NOW,
    onRevokeBound: () => Promise.reject(new Error('revoked twice')),
  })
  assertEquals(again, { licenseIds: [], serverIds: [] })
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
