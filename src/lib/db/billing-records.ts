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
 * `provider_price_id` on `tier` is the bridge from a provider price to a
 * `tier_id`. An item whose price maps to no tier is **logged and skipped**,
 * never inserted with a null tier: the reconciliation invariant compares
 * seats to licenses per tier, and a null would silently break it.
 */

import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { logWarn } from '../../logger.ts'
import type { PayerSubject } from '../billing/customer-subject.ts'
import { license, payer, subscription, subscriptionItem, tier } from './schema.ts'
import { countActiveLicensesByTier, getTiersByIds } from './tier-records.ts'

/**
 * The handle inside `db.transaction(async (tx) => …)`. The projection
 * (`src/webhook/billing/stripe-projection.ts`) writes `payer` →
 * `subscription` → `seat` under one transaction so a reader never sees the
 * seats of a subscription half-replaced; the write helpers below accept
 * either handle so the same code serves the transaction and a plain call.
 */
export type BillingDbTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type BillingWriteDb = Db | BillingDbTx

/** Matches `payer_provider_check`. */
export type BillingProvider = 'stripe' | 'apple'

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
  quantity: number
}>

export type ReplaceSubscriptionItemsResult = {
  /** Rows written (inserted or updated). */
  written: number
  /** Provider item ids skipped because their price maps to no tier. */
  skipped: string[]
}

/** `provider_price_id` → `tier.id` for the prices named. Unknown prices are absent. */
export async function mapProviderPricesToTierIds(
  db: BillingWriteDb,
  providerPriceIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(providerPriceIds)].filter((id) => id.length > 0)
  if (unique.length === 0) return out
  const rows = await db
    .select({ id: tier.id, providerPriceId: tier.providerPriceId })
    .from(tier)
    .where(inArray(tier.providerPriceId, unique))
  for (const row of rows) {
    if (row.providerPriceId) out.set(row.providerPriceId, row.id)
  }
  return out
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
 * still exists. An upsert-then-prune would throw there, and because the
 * ledger claim is already taken the retry would `204`. Clearing the
 * subscription's rows first makes every shape of item change — replace,
 * swap, remove — a plain insert. `created_at` restarts on each projection,
 * which nothing reads.
 *
 * The delete and the inserts are **not** atomic on their own: an insert that
 * fails halfway would leave the subscription with fewer seats than the
 * provider counts, and every entitlement read would act on that. The
 * projection therefore calls this inside `db.transaction` (with the payer
 * and subscription upserts) so a mid-update error rolls the delete back too.
 */
export async function replaceSubscriptionItems(
  db: BillingWriteDb,
  subscriptionId: string,
  items: readonly ProviderSubscriptionItem[],
  opts: { now?: string; logScope?: string } = {},
): Promise<ReplaceSubscriptionItemsResult> {
  const now = opts.now ?? new Date().toISOString()
  const logScope = opts.logScope ?? 'billing-records'
  const tierByPrice = await mapProviderPricesToTierIds(
    db,
    items.map((item) => item.providerPriceId),
  )

  // Prune first — see the doc comment. Everything on this subscription goes,
  // including rows for items that are about to be skipped as unmappable.
  await db.delete(subscriptionItem).where(eq(subscriptionItem.subscriptionId, subscriptionId))

  const kept: string[] = []
  const skipped: string[] = []
  for (const item of items) {
    const tierId = tierByPrice.get(item.providerPriceId)
    if (!tierId) {
      // Never a null tier: the reconciliation invariant is per tier.
      logWarn(
        logScope,
        `subscription item ${item.providerItemId} names price ${item.providerPriceId}, which maps to no tier; skipped`,
      )
      skipped.push(item.providerItemId)
      continue
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      logWarn(logScope, `subscription item ${item.providerItemId} has quantity ${item.quantity}; skipped`)
      skipped.push(item.providerItemId)
      continue
    }
    // The `provider_item_id` conflict target is belt-and-braces: item ids are
    // globally unique on the provider side, so it can only fire if an id was
    // somehow projected under a different subscription — re-home it.
    await db
      .insert(subscriptionItem)
      .values({
        subscriptionId,
        tierId,
        providerItemId: item.providerItemId,
        quantity: item.quantity,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: subscriptionItem.providerItemId,
        set: { subscriptionId, tierId, quantity: item.quantity, updatedAt: now },
      })
    kept.push(item.providerItemId)
  }

  return { written: kept.length, skipped }
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
  quantity: number
  tier: Readonly<{
    label: string
    generation: number
    rank: number
    priceCents: number | null
    providerPriceId: string | null
    isActive: boolean
  }>
}>

export type OrganizationBillingState = Readonly<{
  payer: PayerRow | null
  subscription: SubscriptionRow | null
  seats: readonly OrganizationSeat[]
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
  const payerRow = await getPayerForOrganization(db, organizationId)
  if (!payerRow) return { payer: null, subscription: null, seats: [] }
  const subscriptionRow = await getSubscriptionForPayer(db, payerRow.id)
  if (!subscriptionRow) return { payer: payerRow, subscription: null, seats: [] }
  const rows = await db
    .select({
      seatId: subscriptionItem.id,
      tierId: subscriptionItem.tierId,
      providerItemId: subscriptionItem.providerItemId,
      quantity: subscriptionItem.quantity,
      label: tier.label,
      generation: tier.generation,
      rank: tier.rank,
      priceCents: tier.priceCents,
      providerPriceId: tier.providerPriceId,
      isActive: tier.isActive,
    })
    .from(subscriptionItem)
    .innerJoin(tier, eq(tier.id, subscriptionItem.tierId))
    .where(eq(subscriptionItem.subscriptionId, subscriptionRow.id))
  const seats: OrganizationSeat[] = rows.map((row) => ({
    seatId: row.seatId,
    tierId: row.tierId,
    providerItemId: row.providerItemId,
    quantity: row.quantity,
    tier: {
      label: row.label,
      generation: row.generation,
      rank: row.rank,
      priceCents: row.priceCents,
      providerPriceId: row.providerPriceId,
      isActive: row.isActive,
    },
  }))
  seats.sort((a, b) => a.tier.generation - b.tier.generation || a.tier.rank - b.tier.rank)
  return { payer: payerRow, subscription: subscriptionRow, seats }
}

/** Committed seats per tier; every tier reads as zero once the subscription ended. */
export function seatQuantitiesByTier(state: OrganizationBillingState): Map<string, number> {
  const out = new Map<string, number>()
  const ended = !state.subscription || isEndedStatus(state.subscription.status)
  for (const seat of state.seats) {
    out.set(seat.tierId, ended ? 0 : (out.get(seat.tierId) ?? 0) + seat.quantity)
  }
  return out
}

/** The subset of a ledger intent `applySeatEntitlements` needs. */
export type EntitlementIntent = Readonly<{
  id: string
  kind: 'upgrade' | 'downgrade' | 'release-seat'
  licenseId: string | null
  fromTierId: string
  toTierId: string | null
}>

export type SeatEntitlementDrift = Readonly<{
  tierId: string
  seats: number
  active: number
  bound: number
  /** Licenses over the seat count that only a bound license could close. */
  excess: number
}>

export type ApplySeatEntitlementsResult = Readonly<{
  consumedIntentIds: string[]
  repointed: { licenseId: string; fromTierId: string; toTierId: string }[]
  revokedLicenseIds: string[]
  /** Servers whose bound license was revoked (subscription ended only). */
  disconnectedServerIds: string[]
  drift: SeatEntitlementDrift[]
}>

export type ApplySeatEntitlementsOpts = Readonly<{
  /** The refetched subscription carries a `pending_update`: never consume an upgrade. */
  pendingUpdate?: boolean
  /** Already-loaded state, to skip the second read. */
  state?: OrganizationBillingState
  now?: string
  /** Called for each server whose bound license is revoked on cancellation. */
  onRevokeBound?: (serverId: string) => Promise<void>
}>

type ActiveLicense = { id: string; tierId: string; serverId: string | null }

/**
 * The one place `license.tier_id` moves in response to billing.
 *
 *  1. Each recorded intent is applied **by id**, and only once the
 *     committed seats show its change landed: an upgrade or downgrade
 *     repoints that exact license when the target tier has room (and, for
 *     a downgrade, the source tier is now short); a `release-seat` is
 *     consumed when the source tier's quantity has dropped below the
 *     licenses still counting against it. A change Stripe parked as
 *     pending, or a replayed `updated` from before the change, changes
 *     nothing — that is what makes this idempotent across deliveries.
 *  2. Any residual gap between seats and active licenses is closed with
 *     **unbound** licenses only (`server_id IS NULL`): repointed **down** to
 *     an equal-or-lower tier with a free seat when one exists, revoked
 *     otherwise. Never up — a spare seat at a higher tier is not a reason
 *     to hand out its entitlements.
 *  3. A gap that only a **bound** license could close is never touched. It
 *     is returned as drift for the reconciliation sweep to alert on; the
 *     daily nag and the enroll floor already show the operator the
 *     consequence.
 *  4. A subscription that ended (seats → 0) is the one case that revokes
 *     bound licenses too, through `onRevokeBound` — the detach-first guard
 *     protects an operator from an accident, and an ended subscription is
 *     not an accident.
 */
export async function applySeatEntitlements(
  db: Db,
  organizationId: string,
  intents: readonly EntitlementIntent[],
  opts: ApplySeatEntitlementsOpts = {},
): Promise<ApplySeatEntitlementsResult> {
  const now = opts.now ?? new Date().toISOString()
  const state = opts.state ?? await listSeatsForOrganization(db, organizationId)
  const result: {
    consumedIntentIds: string[]
    repointed: { licenseId: string; fromTierId: string; toTierId: string }[]
    revokedLicenseIds: string[]
    disconnectedServerIds: string[]
    drift: SeatEntitlementDrift[]
  } = { consumedIntentIds: [], repointed: [], revokedLicenseIds: [], disconnectedServerIds: [], drift: [] }
  // No subscription was ever projected: nothing to compare against.
  if (!state.subscription) return result

  const ended = isEndedStatus(state.subscription.status)
  const seats = seatQuantitiesByTier(state)
  const counts = await countActiveLicensesByTier(db, organizationId)
  const active = new Map<string, number>()
  for (const [tierId, count] of counts) active.set(tierId, count.active)
  const seatsAt = (tierId: string) => seats.get(tierId) ?? 0
  const activeAt = (tierId: string) => active.get(tierId) ?? 0
  const bump = (tierId: string, delta: number) => active.set(tierId, activeAt(tierId) + delta)

  const licenses: ActiveLicense[] = await db
    .select({ id: license.id, tierId: license.tierId, serverId: license.serverId })
    .from(license)
    .where(and(eq(license.organizationId, organizationId), isNull(license.revokedAt), isNotNull(license.tierId)))
    .then((rows) => rows.flatMap((row) => (row.tierId ? [{ id: row.id, tierId: row.tierId, serverId: row.serverId }] : [])))
  const licenseById = new Map(licenses.map((row) => [row.id, row]))

  const repoint = async (row: ActiveLicense, toTierId: string): Promise<void> => {
    await db
      .update(license)
      .set({ tierId: toTierId, updatedAt: now })
      .where(and(eq(license.id, row.id), eq(license.organizationId, organizationId), isNull(license.revokedAt)))
    result.repointed.push({ licenseId: row.id, fromTierId: row.tierId, toTierId })
    bump(row.tierId, -1)
    bump(toTierId, 1)
    row.tierId = toTierId
  }
  const revoke = async (row: ActiveLicense): Promise<void> => {
    await db
      .update(license)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(license.id, row.id), eq(license.organizationId, organizationId), isNull(license.revokedAt)))
    result.revokedLicenseIds.push(row.id)
    bump(row.tierId, -1)
    licenseById.delete(row.id)
    if (row.serverId) {
      result.disconnectedServerIds.push(row.serverId)
      if (opts.onRevokeBound) await opts.onRevokeBound(row.serverId)
    }
  }

  // Outstanding releases per source tier: their licenses are already
  // revoked, so the provider still counts one seat each until the boundary.
  const releasesAt = new Map<string, number>()
  for (const intent of intents) {
    if (intent.kind === 'release-seat') {
      releasesAt.set(intent.fromTierId, (releasesAt.get(intent.fromTierId) ?? 0) + 1)
    }
  }

  // 1. Intents by id.
  for (const intent of intents) {
    const row = intent.licenseId ? licenseById.get(intent.licenseId) : undefined
    if (intent.kind === 'release-seat') {
      const outstanding = releasesAt.get(intent.fromTierId) ?? 0
      const landed = ended || seatsAt(intent.fromTierId) < activeAt(intent.fromTierId) + outstanding
      if (!landed) continue
      releasesAt.set(intent.fromTierId, Math.max(0, outstanding - 1))
      result.consumedIntentIds.push(intent.id)
      continue
    }
    if (!row) {
      // The license is gone (revoked meanwhile): the intent has nothing to move.
      result.consumedIntentIds.push(intent.id)
      continue
    }
    if (!intent.toTierId || row.tierId !== intent.fromTierId) {
      result.consumedIntentIds.push(intent.id)
      continue
    }
    if (intent.kind === 'upgrade' && opts.pendingUpdate) continue
    const room = seatsAt(intent.toTierId) - activeAt(intent.toTierId) > 0
    const sourceShort = seatsAt(intent.fromTierId) < activeAt(intent.fromTierId)
    if (!room) continue
    if (intent.kind === 'downgrade' && !sourceShort) continue
    await repoint(row, intent.toTierId)
    result.consumedIntentIds.push(intent.id)
  }

  // 2 – 4. Residual gaps, per tier, unbound licenses first.
  const tierIds = new Set<string>([...seats.keys(), ...active.keys()])
  const tierRank = await getTiersByIds(db, [...tierIds])
  const lowerOrEqual = (candidate: string, source: string): boolean => {
    const a = tierRank.get(candidate)
    const b = tierRank.get(source)
    if (!a || !b) return false
    return a.generation < b.generation || (a.generation === b.generation && a.rank <= b.rank)
  }
  for (const tierId of tierIds) {
    let excess = activeAt(tierId) - seatsAt(tierId)
    if (excess <= 0) continue
    const atTier = licenses.filter((row) => row.tierId === tierId && licenseById.has(row.id))
    const unbound = atTier.filter((row) => row.serverId === null)
    for (const row of unbound) {
      if (excess <= 0) break
      const target = [...seats.keys()]
        .filter((candidate) => candidate !== tierId && lowerOrEqual(candidate, tierId))
        .sort((x, y) => {
          const a = tierRank.get(x)!
          const b = tierRank.get(y)!
          return b.generation - a.generation || b.rank - a.rank
        })
        .find((candidate) => seatsAt(candidate) - activeAt(candidate) > 0)
      if (target) await repoint(row, target)
      else await revoke(row)
      excess -= 1
    }
    if (excess <= 0) continue
    if (ended) {
      for (const row of atTier.filter((candidate) => candidate.serverId !== null && licenseById.has(candidate.id))) {
        if (excess <= 0) break
        await revoke(row)
        excess -= 1
      }
      continue
    }
    const bound = atTier.filter((row) => row.serverId !== null).length
    result.drift.push({ tierId, seats: seatsAt(tierId), active: activeAt(tierId), bound, excess })
  }

  return result
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
