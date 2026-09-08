/**
 * Database-backed coverage for the billing projection's constraints (ledger
 * T15): what Postgres itself refuses, and that the projection's
 * delete-then-insert really rolls back inside a transaction. Skips without
 * `TURBOPANEL_DATABASE_URL`; the migrations must be applied.
 */

import { assertEquals } from '@std/assert'
import { eq, like } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb, endDbConnection } from '../../db.ts'
import { replaceSubscriptionItems } from './billing-records.ts'
import { organization, payer, subscription, subscriptionItem, tier, user, webhookDelivery } from './schema.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const RUN = `t15-${crypto.randomUUID().slice(0, 8)}`

type Ctx = {
  db: ReturnType<typeof createDenoDb>
  organizationId: string
  userId: string
  tierA: string
  tierB: string
  generation: number
}

/** One organization, one user and two priced tiers, all removed afterwards. */
async function withDb(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping billing constraint tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const generation = 1_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const [org] = await db.insert(organization).values({ name: `Billing constraints ${RUN}` }).returning({ id: organization.id })
  const [usr] = await db.insert(user).values({ email: `${RUN}@example.invalid` }).returning({ id: user.id })
  const tierValues = (rank: number, label: string) => ({
    generation, rank, label, priceCents: 1000 * rank, providerPriceId: `price_${RUN}_${label}`,
    maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1,
  })
  const [a] = await db.insert(tier).values(tierValues(1, 'S1')).returning({ id: tier.id })
  const [b] = await db.insert(tier).values(tierValues(2, 'S2')).returning({ id: tier.id })
  try {
    await fn({ db, organizationId: org!.id, userId: usr!.id, tierA: a!.id, tierB: b!.id, generation })
  } finally {
    // payer → subscription → seat cascade from the organization; tiers after.
    await db.delete(organization).where(eq(organization.id, org!.id))
    await db.delete(user).where(eq(user.id, usr!.id))
    await db.delete(tier).where(eq(tier.generation, generation))
    await db.delete(webhookDelivery).where(like(webhookDelivery.externalDeliveryId, `${RUN}%`))
    await endDbConnection(db)
  }
}

/** The Postgres error under whatever drizzle wrapped it in. */
function pgError(err: unknown): { code?: string; constraint_name?: string } {
  const cause = (err as { cause?: unknown }).cause
  return (cause ?? err) as { code?: string; constraint_name?: string }
}

async function expectPgRefusal(work: Promise<unknown>, code: string, constraint: string): Promise<void> {
  let caught: unknown = null
  try {
    await work
  } catch (err) {
    caught = err
  }
  if (caught === null) throw new Error(`expected Postgres to refuse with ${constraint}`)
  const pg = pgError(caught)
  assertEquals(pg.code, code, constraint)
  assertEquals(pg.constraint_name, constraint)
}

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'

async function projectedSubscription(ctx: Ctx): Promise<{ payerId: string; subscriptionId: string }> {
  const [p] = await ctx.db
    .insert(payer)
    .values({ provider: 'stripe', providerCustomerId: `cus_${RUN}`, organizationId: ctx.organizationId, userId: null })
    .returning({ id: payer.id })
  const [s] = await ctx.db
    .insert(subscription)
    .values({ payerId: p!.id, providerSubscriptionId: `sub_${RUN}`, status: 'active' })
    .returning({ id: subscription.id })
  return { payerId: p!.id, subscriptionId: s!.id }
}

test('T15 · payer_subject_check: exactly one of organization or user, enforced by Postgres', async () => {
  await withDb(async (ctx) => {
    await expectPgRefusal(
      ctx.db.insert(payer).values({ provider: 'stripe', providerCustomerId: `cus_${RUN}_none`, organizationId: null, userId: null }),
      CHECK_VIOLATION,
      'payer_subject_check',
    )
    await expectPgRefusal(
      ctx.db.insert(payer).values({ provider: 'stripe', providerCustomerId: `cus_${RUN}_both`, organizationId: ctx.organizationId, userId: ctx.userId }),
      CHECK_VIOLATION,
      'payer_subject_check',
    )
    const [org] = await ctx.db
      .insert(payer)
      .values({ provider: 'stripe', providerCustomerId: `cus_${RUN}_org`, organizationId: ctx.organizationId, userId: null })
      .returning({ id: payer.id })
    assertEquals(typeof org?.id, 'string')
    // A second customer for the same organization is refused, not re-homed.
    await expectPgRefusal(
      ctx.db.insert(payer).values({ provider: 'stripe', providerCustomerId: `cus_${RUN}_dup`, organizationId: ctx.organizationId, userId: null }),
      UNIQUE_VIOLATION,
      'uniq_payer_organization_provider',
    )
  })
})

test('T15 · the delivery ledger accepts stripe and refuses any other provider', async () => {
  await withDb(async (ctx) => {
    const [row] = await ctx.db
      .insert(webhookDelivery)
      .values({ provider: 'stripe', externalDeliveryId: `${RUN}-evt_1`, event: 'customer.subscription.updated' })
      .returning({ id: webhookDelivery.id })
    assertEquals(typeof row?.id, 'string')
    await expectPgRefusal(
      ctx.db.insert(webhookDelivery).values({ provider: 'paypal', externalDeliveryId: `${RUN}-evt_2`, event: 'x' }),
      CHECK_VIOLATION,
      'delivery_provider_check',
    )
    // The same delivery id twice from the same provider is the duplicate claim the gate answers 204 to.
    await expectPgRefusal(
      ctx.db.insert(webhookDelivery).values({ provider: 'stripe', externalDeliveryId: `${RUN}-evt_1`, event: 'replay' }),
      UNIQUE_VIOLATION,
      'uniq_delivery_provider_external',
    )
  })
})

test('T15 · one seat row per (subscription, tier), and one per provider item id', async () => {
  await withDb(async (ctx) => {
    const { subscriptionId } = await projectedSubscription(ctx)
    await ctx.db.insert(subscriptionItem).values({ subscriptionId, tierId: ctx.tierA, providerItemId: `si_${RUN}_1`, quantity: 2 })
    await expectPgRefusal(
      ctx.db.insert(subscriptionItem).values({ subscriptionId, tierId: ctx.tierA, providerItemId: `si_${RUN}_2`, quantity: 1 }),
      UNIQUE_VIOLATION,
      'uniq_seat_subscription_tier',
    )
    await expectPgRefusal(
      ctx.db.insert(subscriptionItem).values({ subscriptionId, tierId: ctx.tierB, providerItemId: `si_${RUN}_1`, quantity: 1 }),
      UNIQUE_VIOLATION,
      'uniq_seat_provider_item',
    )
  })
})

test('T15 · the seat replacement really rolls back: a failure after the delete leaves the old rows in place', async () => {
  await withDb(async (ctx) => {
    const { subscriptionId } = await projectedSubscription(ctx)
    await ctx.db.insert(subscriptionItem).values({ subscriptionId, tierId: ctx.tierA, providerItemId: `si_${RUN}_old`, quantity: 2 })

    let threw = false
    try {
      await ctx.db.transaction(async (tx) => {
        const replaced = await replaceSubscriptionItems(tx, subscriptionId, [
          { providerItemId: `si_${RUN}_new`, providerPriceId: `price_${RUN}_S2`, quantity: 5 },
        ])
        assertEquals(replaced.written, 1)
        throw new Error('injected: failure after the replace')
      })
    } catch (err) {
      threw = String(err).includes('injected')
    }
    assertEquals(threw, true)

    const rows = await ctx.db.select().from(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subscriptionId))
    assertEquals(rows.map((row) => [row.providerItemId, row.tierId, row.quantity]), [[`si_${RUN}_old`, ctx.tierA, 2]])
  })
})

test('T15 · tier uniqueness from migration 0004: (generation, rank) and a non-null provider price id', async () => {
  await withDb(async (ctx) => {
    const base = { maxCores: 4, maxMemoryBytes: 1, nicSlots: 1, driveSlots: 1, gpuSlots: 0, filesystemSlots: 1 }
    await expectPgRefusal(
      ctx.db.insert(tier).values({ ...base, generation: ctx.generation, rank: 1, label: 'S1b', priceCents: 1, providerPriceId: `price_${RUN}_other` }),
      UNIQUE_VIOLATION,
      'uniq_tier_generation_rank',
    )
    await expectPgRefusal(
      ctx.db.insert(tier).values({ ...base, generation: ctx.generation, rank: 3, label: 'S3', priceCents: 1, providerPriceId: `price_${RUN}_S1` }),
      UNIQUE_VIOLATION,
      'uniq_tier_provider_price_id',
    )
    // Two unpriced rows (custom tiers) may coexist: the index is partial.
    await ctx.db.insert(tier).values({ ...base, generation: ctx.generation, rank: 8, label: 'SX', priceCents: null, providerPriceId: null, isCustom: true })
    await ctx.db.insert(tier).values({ ...base, generation: ctx.generation, rank: 9, label: 'SY', priceCents: null, providerPriceId: null, isCustom: true })
  })
})
