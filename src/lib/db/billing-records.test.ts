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
  /** The fixture's rank base: `uniq_tier_rank` is global, so ranks are minted away from the ladder's 1…8. */
  rankBase: number
}

/**
 * One organization, one user and two priced tiers, all removed afterwards.
 * `uniq_tier_label` and `uniq_tier_rank` are global (no generation
 * namespaces them any more), so the fixture's labels and ranks are minted
 * per run — `label` is plain text to Postgres; only `insertTier` checks it
 * against the ladder, and this suite writes the rows directly.
 */
async function withDb(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping billing constraint tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const rankBase = 1_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const [org] = await db.insert(organization).values({ name: `Billing constraints ${RUN}` }).returning({ id: organization.id })
  const [usr] = await db.insert(user).values({ email: `${RUN}@example.invalid` }).returning({ id: user.id })
  const tierValues = (offset: number, label: string) => ({
    label: `${RUN}_${label}`, rank: rankBase + offset, provider: 'stripe', providerProductId: `prod_${RUN}_${label}`,
    priceCents: 1000 * offset, currency: 'usd',
  })
  const [a] = await db.insert(tier).values(tierValues(1, 'S1')).returning({ id: tier.id })
  const [b] = await db.insert(tier).values(tierValues(2, 'S2')).returning({ id: tier.id })
  try {
    await fn({ db, organizationId: org!.id, userId: usr!.id, tierA: a!.id, tierB: b!.id, rankBase })
  } finally {
    // payer → subscription → seat cascade from the organization; tiers after.
    await db.delete(organization).where(eq(organization.id, org!.id))
    await db.delete(user).where(eq(user.id, usr!.id))
    await db.delete(tier).where(like(tier.label, `${RUN}%`))
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
          { providerItemId: `si_${RUN}_new`, providerPriceId: `price_${RUN}_S2`, providerProductId: `prod_${RUN}_S2`, quantity: 5 },
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

test('T15 · tier uniqueness: one row per label, per rank and per (provider, product); the provider is checked', async () => {
  await withDb(async (ctx) => {
    const fresh = (offset: number, label: string) => ({
      label: `${RUN}_${label}`, rank: ctx.rankBase + offset, provider: 'stripe', providerProductId: `prod_${RUN}_${label}`,
      priceCents: 1, currency: 'usd',
    })
    // The fixture already holds `${RUN}_S1` at rankBase + 1 on `prod_${RUN}_S1`.
    await expectPgRefusal(
      ctx.db.insert(tier).values({ ...fresh(3, 'S3'), label: `${RUN}_S1` }),
      UNIQUE_VIOLATION,
      'uniq_tier_label',
    )
    await expectPgRefusal(
      ctx.db.insert(tier).values({ ...fresh(3, 'S3'), rank: ctx.rankBase + 1 }),
      UNIQUE_VIOLATION,
      'uniq_tier_rank',
    )
    await expectPgRefusal(
      ctx.db.insert(tier).values({ ...fresh(3, 'S3'), providerProductId: `prod_${RUN}_S1` }),
      UNIQUE_VIOLATION,
      'uniq_tier_provider_product',
    )
    await expectPgRefusal(
      ctx.db.insert(tier).values({ ...fresh(3, 'S3'), provider: 'paypal' }),
      CHECK_VIOLATION,
      'tier_provider_check',
    )
    // The product index is partial: two rows with no product (custom tiers) may coexist.
    await ctx.db.insert(tier).values({ ...fresh(8, 'SX'), providerProductId: null, priceCents: null, currency: null, isCustom: true })
    await ctx.db.insert(tier).values({ ...fresh(9, 'SY'), providerProductId: null, priceCents: null, currency: null, isCustom: true })
    // …and the same product id on another provider is another catalogue, not a duplicate.
    await ctx.db.insert(tier).values({ ...fresh(10, 'S1A'), provider: 'apple', providerProductId: `prod_${RUN}_S1` })
  })
})
