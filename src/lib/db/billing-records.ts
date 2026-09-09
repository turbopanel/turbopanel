/**
 * Billing projection helpers (`payer` / `subscription` / `seat`).
 *
 * **Stripe owns money, Postgres owns entitlement.** These helpers are the
 * only write path from the webhook ingress into the projection, and every
 * entitlement read in the system — license minting, tier placement, the
 * metrics truncation that runs on every sample — is a local query against
 * these rows. Nothing on the ingest or page-load path may call Stripe: a
 * Stripe outage must not break monitoring, and a Stripe call per sample is
 * not a cost anyone can pay.
 *
 * Writes are idempotent upserts keyed on the provider's own ids, because
 * delivery is at-least-once and unordered; the caller refetches the object
 * from the provider before calling in here, so every write is from current
 * state rather than from a possibly stale replay.
 *
 * `provider_product_id` on `tier` is the bridge from a provider item to a
 * `tier_id` — an item names a price, a price names its product, and the
 * product names the tier. An item whose product maps to no tier is
 * **logged and skipped**, never inserted with a null tier: the assignment
 * and the reconcile report are per tier, and a null would silently break
 * them. Two items on one product (a re-price plus a hand edit) are summed
 * into one seat row under the first item's id.
 */

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { BillingProviderId } from '../billing/gateway.ts'
import type { Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import type { PayerSubject } from '../billing/customer-subject.ts'
import { license, payer, setting, subscription, subscriptionItem, tier } from './schema.ts'
import { mapProviderProductsToTierIds } from './tier-records.ts'
import {
  parseSelfHostedGrant,
  type SelfHostedGrant,
  selfHostedGrantKey,
} from '../tiers/self-hosted-grant.ts'

/**
 * The handle inside `db.transaction(async (tx) => …)`. The projection
 * (`src/webhook/billing/stripe-projection.ts`) writes `payer` →
 * `subscription` → `seat` under one transaction so a reader never sees the
 * seats of a subscription half-replaced; the write helpers below accept
 * either handle so the same code serves the transaction and a plain call.
 */
export type BillingDbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type BillingWriteDb = Db | BillingDbTx

/** Matches `payer_provider_check` and `tier_provider_check`. */
export type BillingProvider = BillingProviderId

/**
 * Provider statuses this projection acts on. Anything else is stored
 * verbatim (`subscription.status` has no CHECK on purpose) and narrowed at
 * read time by `parseSubscriptionStatus`.
 */
export const KNOWN_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const

export type SubscriptionStatus = (typeof KNOWN_SUBSCRIPTION_STATUSES)[number]

/**
 * Statuses under which the grace clock runs. Stripe stays `past_due`
 * indefinitely by design (Smart Retries, then "leave past-due" — a
 * Dashboard setting, not an API field), and moves to `unpaid` only when the
 * account is configured that way; both mean "not paid, still entitled".
 */
export const DELINQUENT_SUBSCRIPTION_STATUSES: readonly string[] = ['past_due', 'unpaid']

export function isDelinquentStatus(status: string): boolean {
  return DELINQUENT_SUBSCRIPTION_STATUSES.includes(status)
}

/** A subscription that has ended: its seats count as zero. */
export function isEndedStatus(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired'
}

/**
 * How long entitlement survives past the first missed payment: Stripe's
 * two-month Smart Retry window plus a margin. The only place the grace
 * length is written; the grace clock (`src/lib/billing/grace-clock.ts`)
 * cancels what is still delinquent when `grace_expires_at` passes.
 */
export const BILLING_GRACE_WINDOW_MS = 65 * 24 * 60 * 60 * 1000

export function parseSubscriptionStatus(value: string): SubscriptionStatus | 'unknown' {
  return (KNOWN_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
    ? (value as SubscriptionStatus)
    : 'unknown'
}

export type PayerRow = typeof payer.$inferSelect
export type SubscriptionRow = typeof subscription.$inferSelect
export type SubscriptionItemRow = typeof subscriptionItem.$inferSelect

export type UpsertPayerInput = Readonly<{
  provider: BillingProvider
  providerCustomerId: string
  subject: PayerSubject
  taxId?: string | null
  now?: string
}>

/**
 * Insert-or-update on `(provider, provider_customer_id)`.
 *
 * The subject is written on insert only. A customer that later names a
 * different organization is not silently re-homed — that is a provider-side
 * mistake to surface, not a projection to apply. The same goes the other
 * way: a *second* customer naming an organization that already has a payer
 * throws on `uniq_payer_organization_provider` (or the `user` mirror). That
 * is deliberate — one subject holds one payer per provider, and the throw is
 * what makes the mistake visible in the task log instead of a silent
 * re-home.
 */
export async function upsertPayer(
  db: BillingWriteDb,
  input: UpsertPayerInput,
): Promise<{ id: string }> {
  const now = input.now ?? new Date().toISOString()
  const [row] = await db
    .insert(payer)
    .values({
      provider: input.provider,
      providerCustomerId: input.providerCustomerId,
      organizationId: input.subject.organizationId,
      userId: input.subject.userId,
      taxId: input.taxId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [payer.provider, payer.providerCustomerId],
      set: { taxId: input.taxId ?? null, updatedAt: now },
    })
    .returning({ id: payer.id })
  if (!row) throw new Error('upsertPayer returned no row')
  return row
}

export type UpsertSubscriptionInput = Readonly<{
  payerId: string
  providerSubscriptionId: string
  status: string
  currentPeriodEnd: string | null
  scheduleId: string | null
  now?: string
}>

/**
 * Insert-or-update on `provider_subscription_id`.
 *
 * `past_due_since` is a latch: set the first time the provider reports a
 * delinquent status (`past_due` / `unpaid`), kept while it stays there,
 * cleared by any other status. `grace_expires_at` latches beside it —
 * `coalesce(existing, past_due_since + BILLING_GRACE_WINDOW_MS)` while
 * delinquent, `null` otherwise — so recovery resets the clock and a second
 * lapse starts a fresh window.
 */
export async function upsertSubscriptionFromProvider(
  db: BillingWriteDb,
  input: UpsertSubscriptionInput,
): Promise<{ id: string }> {
  const now = input.now ?? new Date().toISOString()
  const pastDue = isDelinquentStatus(input.status)
  const graceSeconds = Math.floor(BILLING_GRACE_WINDOW_MS / 1000)
  const [row] = await db
    .insert(subscription)
    .values({
      payerId: input.payerId,
      providerSubscriptionId: input.providerSubscriptionId,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd,
      scheduleId: input.scheduleId,
      pastDueSince: pastDue ? now : null,
      graceExpiresAt: pastDue
        ? new Date(Date.parse(now) + BILLING_GRACE_WINDOW_MS).toISOString()
        : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: subscription.providerSubscriptionId,
      set: {
        payerId: input.payerId,
        status: input.status,
        currentPeriodEnd: input.currentPeriodEnd,
        scheduleId: input.scheduleId,
        pastDueSince: pastDue
          ? sql`coalesce(${subscription.pastDueSince}, ${now}::timestamptz)`
          : null,
        graceExpiresAt: pastDue
          ? sql`coalesce(${subscription.graceExpiresAt}, coalesce(${subscription.pastDueSince}, ${now}::timestamptz) + make_interval(secs => ${graceSeconds}))`
          : null,
        updatedAt: now,
      },
    })
    .returning({ id: subscription.id })
  if (!row) throw new Error('upsertSubscriptionFromProvider returned no row')
  return row
}

export type ProviderSubscriptionItem = Readonly<{
  providerItemId: string
  providerPriceId: string
  /** The price's product — what maps to a tier. */
  providerProductId: string
  quantity: number
}>

export type ReplaceSubscriptionItemsResult = {
  /** Rows written (inserted or updated). */
  written: number
  /** Provider item ids skipped because their product maps to no tier, or folded into another item on the same tier. */
  skipped: string[]
}

/**
 * Make the `seat` rows for one subscription equal the provider's item list.
 *
 * **Delete-then-insert, in that order, scoped to one `subscription_id`,
 * and always inside the projection's transaction.**
 * The table has two uniques — `provider_item_id` and
 * `(subscription_id, tier_id)` — and Stripe's ordinary "replace item" flow
 * (a proration or plan swap deletes `si_1` and adds `si_2` at the same
 * price) trips the second one if the new row is written while the old one
 * still exists. Clearing the subscription's rows first makes every shape
 * of item change — replace, swap, remove — a plain insert.
 *
 * Items are mapped to tiers by **product**. Two items whose products map
 * to the same tier (one price retired, one live) are summed into one row
 * under the first item's id, with a warning: the quantity is what
 * entitlement reads, and a throw here would be a silent entitlement outage
 * inside the webhook task.
 *
 * The delete and the inserts are **not** atomic on their own; the
 * projection calls this inside `db.transaction` so a mid-update error
 * rolls the delete back too.
 */
export async function replaceSubscriptionItems(
  db: BillingWriteDb,
  subscriptionId: string,
  items: readonly ProviderSubscriptionItem[],
  opts: { now?: string; logScope?: string; provider?: BillingProvider } = {},
): Promise<ReplaceSubscriptionItemsResult> {
  const now = opts.now ?? new Date().toISOString()
  const logScope = opts.logScope ?? 'billing-records'
  const tierByProduct = await mapProviderProductsToTierIds(
    db as Db,
    opts.provider ?? 'stripe',
    items.map((item) => item.providerProductId),
  )

  // Prune first — see the doc comment. Everything on this subscription goes,
  // including rows for items that are about to be skipped as unmappable.
  await db.delete(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subscriptionId))

  const skipped: string[] = []
  const byTier = new Map<string, { providerItemId: string; providerPriceId: string; quantity: number }>()
  for (const item of items) {
    const tierId = tierByProduct.get(item.providerProductId)
    if (!tierId) {
      // Never a null tier: the assignment is per tier.
      logWarn(
        logScope,
        `subscription item ${item.providerItemId} names product ${item.providerProductId}, which maps to no tier; skipped`,
      )
      skipped.push(item.providerItemId)
      continue
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      logWarn(logScope, `subscription item ${item.providerItemId} has quantity ${item.quantity}; skipped`)
      skipped.push(item.providerItemId)
      continue
    }
    const existing = byTier.get(tierId)
    if (existing) {
      logWarn(
        logScope,
        `subscription item ${item.providerItemId} maps to the same tier as ${existing.providerItemId}; quantities summed under the first`,
      )
      existing.quantity += item.quantity
      skipped.push(item.providerItemId)
      continue
    }
    byTier.set(tierId, { providerItemId: item.providerItemId, providerPriceId: item.providerPriceId, quantity: item.quantity })
  }

  for (const [tierId, line] of byTier) {
    // The `provider_item_id` conflict target is belt-and-braces: item ids are
    // globally unique on the provider side, so it can only fire if an id was
    // somehow projected under a different subscription — re-home it.
    await db
      .insert(subscriptionItem)
      .values({
        subscriptionId,
        tierId,
        providerItemId: line.providerItemId,
        providerPriceId: line.providerPriceId,
        quantity: line.quantity,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptionItem.providerItemId,
        set: { subscriptionId, tierId, providerPriceId: line.providerPriceId, quantity: line.quantity, updatedAt: now },
      })
  }

  return { written: byTier.size, skipped }
}

export async function getPayerForOrganization(
  db: Db,
  organizationId: string,
  provider: BillingProvider = 'stripe',
): Promise<PayerRow | null> {
  const [row] = await db
    .select()
    .from(payer)
    .where(and(eq(payer.organizationId, organizationId), eq(payer.provider, provider)))
    .limit(1)
  return row ?? null
}

/** The most recently created subscription for a payer (a payer holds at most a few). */
export async function getSubscriptionForPayer(
  db: Db,
  payerId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(subscription)
    .where(eq(subscription.payerId, payerId))
    .orderBy(desc(subscription.createdAt))
    .limit(1)
  return row ?? null
}

export async function listSubscriptionItems(
  db: Db,
  subscriptionId: string,
): Promise<SubscriptionItemRow[]> {
  return await db
    .select()
    .from(subscriptionItem)
    .where(eq(subscriptionItem.subscriptionId, subscriptionId))
    .orderBy(desc(subscriptionItem.quantity))
}

/** One projected seat line joined to its tier — what every page and sweep reads. */
export type OrganizationSeat = Readonly<{
  seatId: string
  tierId: string
  providerItemId: string
  /** The item's own price; `null` only on a row projected before the column existed. */
  providerPriceId: string | null
  quantity: number
  tier: Readonly<{
    label: string
    rank: number
    priceCents: number | null
    currency: string | null
    providerProductId: string | null
    isActive: boolean
  }>
}>

export type OrganizationBillingState = Readonly<{
  payer: PayerRow | null
  subscription: SubscriptionRow | null
  seats: readonly OrganizationSeat[]
  /**
   * The self-hosted grant, when this organization holds one
   * (`src/lib/tiers/self-hosted-grant.ts`). It is an entitlement, not a
   * purchase: it is deliberately **not** a member of `seats`, so nothing
   * that restates a provider `items[]` array can ever emit it, and it is
   * counted only by the entitlement readers — `tierQuantitiesFromState`
   * and the license summary.
   */
  grant: SelfHostedGrant | null
}>

/**
 * payer → subscription → seats joined to `tier`, for one organization.
 * Postgres only — this is the read behind `GET /billing/subscription`,
 * the free-seat check and both sweeps, and none of them may call Stripe.
 */
export async function listSeatsForOrganization(
  db: Db,
  organizationId: string,
): Promise<OrganizationBillingState> {
  // The grant is read alongside the payer, not instead of it: a self-hosted
  // organization has a grant and no payer, and an instance moved to the
  // hosted runtime holds both until the grant has been spent down.
  const [payerRow, grant] = await Promise.all([
    getPayerForOrganization(db, organizationId),
    readGrantForOrganization(db, organizationId),
  ])
  if (!payerRow) return { payer: null, subscription: null, seats: [], grant }
  const subscriptionRow = await getSubscriptionForPayer(db, payerRow.id)
  if (!subscriptionRow) return { payer: payerRow, subscription: null, seats: [], grant }
  const rows = await db
    .select({
      seatId: subscriptionItem.id,
      tierId: subscriptionItem.tierId,
      providerItemId: subscriptionItem.providerItemId,
      providerPriceId: subscriptionItem.providerPriceId,
      quantity: subscriptionItem.quantity,
      label: tier.label,
      rank: tier.rank,
      priceCents: tier.priceCents,
      currency: tier.currency,
      providerProductId: tier.providerProductId,
      isActive: tier.isActive,
    })
    .from(subscriptionItem)
    .innerJoin(tier, eq(tier.id, subscriptionItem.tierId))
    .where(eq(subscriptionItem.subscriptionId, subscriptionRow.id))
  const seats: OrganizationSeat[] = rows.map((row) => ({
    seatId: row.seatId,
    tierId: row.tierId,
    providerItemId: row.providerItemId,
    providerPriceId: row.providerPriceId,
    quantity: row.quantity,
    tier: {
      label: row.label,
      rank: row.rank,
      priceCents: row.priceCents,
      currency: row.currency,
      providerProductId: row.providerProductId,
      isActive: row.isActive,
    },
  }))
  seats.sort((a, b) => a.tier.rank - b.tier.rank)
  return { payer: payerRow, subscription: subscriptionRow, seats, grant }
}

/**
 * The self-hosted grant row for one organization. Read here rather than in
 * `src/lib/tiers/self-hosted-grant-records.ts` so `OrganizationBillingState`
 * is complete wherever it is loaded, and so this module keeps its own
 * dependency direction (the tier tree reads billing, not the reverse).
 */
async function readGrantForOrganization(
  db: Db,
  organizationId: string,
): Promise<SelfHostedGrant | null> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, selfHostedGrantKey(organizationId)))
    .limit(1)
  return row ? parseSelfHostedGrant(row.value) : null
}

/**
 * Committed **provider** seats per tier; every tier reads as zero once the
 * subscription ended. The self-hosted grant is deliberately absent: this is
 * what a mutation restates to the provider (`fromQuantity`) and what the
 * per-tier billing table renders, and neither may name a granted unit. The
 * entitlement total that does include the grant is
 * `tierQuantitiesFromState` in `src/lib/tiers/assignment-records.ts`.
 */
export function seatQuantitiesByTier(state: OrganizationBillingState): Map<string, number> {
  const out = new Map<string, number>()
  const ended = !state.subscription || isEndedStatus(state.subscription.status)
  for (const seat of state.seats) {
    out.set(seat.tierId, ended ? 0 : (out.get(seat.tierId) ?? 0) + seat.quantity)
  }
  return out
}

export type RevokedLicenses = Readonly<{
  licenseIds: string[]
  /** Servers whose bound license was revoked. */
  serverIds: string[]
}>

/**
 * The one case billing revokes licenses: the subscription **ended**
 * (cancelled, or the grace clock ran out). Every active license goes,
 * bound ones included — the detach-first guard on the revoke route
 * protects an operator from an accident, and an ended subscription is not
 * an accident. `onRevokeBound` runs per bound server so the caller can
 * revoke its daemon key.
 */
export async function revokeAllLicensesForOrganization(
  db: Db,
  organizationId: string,
  opts: { now?: string; onRevokeBound?: (serverId: string) => Promise<void> } = {},
): Promise<RevokedLicenses> {
  const now = opts.now ?? new Date().toISOString()
  const rows = await db
    .select({ id: license.id, serverId: license.serverId })
    .from(license)
    .where(and(eq(license.organizationId, organizationId), isNull(license.revokedAt)))
  const out: { licenseIds: string[]; serverIds: string[] } = { licenseIds: [], serverIds: [] }
  for (const row of rows) {
    await db
      .update(license)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(license.id, row.id), isNull(license.revokedAt)))
    out.licenseIds.push(row.id)
    if (row.serverId) {
      out.serverIds.push(row.serverId)
      if (opts.onRevokeBound) await opts.onRevokeBound(row.serverId)
    }
  }
  return out
}

export type ListGraceExpiredOpts = Readonly<{
  /** Narrow the batch to one subscription — the live harness's scope, never the tick's. */
  providerSubscriptionId?: string
}>

/** Delinquent subscriptions whose grace clock has run out — the cancel batch. */
export async function listGraceExpiredSubscriptions(
  db: Db,
  nowIso: string,
  limit: number,
  opts: ListGraceExpiredOpts = {},
): Promise<SubscriptionRow[]> {
  return await db
    .select()
    .from(subscription)
    .where(
      and(
        inArray(subscription.status, [...DELINQUENT_SUBSCRIPTION_STATUSES]),
        isNotNull(subscription.graceExpiresAt),
        sql`${subscription.graceExpiresAt} <= ${nowIso}::timestamptz`,
        ...(opts.providerSubscriptionId
          ? [eq(subscription.providerSubscriptionId, opts.providerSubscriptionId)]
          : []),
      ),
    )
    .orderBy(subscription.graceExpiresAt)
    .limit(limit)
}

/** Every organization with a projected payer, for the reconciliation sweep. */
export async function listOrganizationIdsWithPayer(
  db: Db,
  provider: BillingProvider = 'stripe',
): Promise<string[]> {
  const rows = await db
    .select({ organizationId: payer.organizationId })
    .from(payer)
    .where(and(eq(payer.provider, provider), isNotNull(payer.organizationId)))
  return rows.flatMap((row) => (row.organizationId ? [row.organizationId] : []))
}
