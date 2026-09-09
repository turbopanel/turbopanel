/**
 * The billing mutations, as functions — what `routes.ts` answers with and
 * what the live harness (`scripts/billing-test-clock-harness.ts`) drives.
 *
 * Each one is the body of exactly one route (`POST /billing/seats`,
 * `/billing/upgrade`, `/billing/downgrade`) with the HTTP peeled off: it
 * validates, takes the organization's quantity lease, runs the coverage
 * gate, records what must survive a retry, calls `mutateSubscription`,
 * reprojects under the same lease, and returns the status and body the
 * route sends verbatim. A refusal is a value (`ok: false`), never a thrown
 * error; a Stripe failure is thrown as the `StripeApiError` it is, for the
 * route to map with `stripeErrorResponse` — a deferred change rolls its
 * intents back first.
 *
 * Every mutation is a **quantity** change. Nothing names a license or a
 * server: which server sits on which tier is recomputed after the
 * reprojection (`entitlements.ts`). An upgrade is "+1 at the higher tier,
 * −1 at the lower, now"; a downgrade is the same pair parked at the period
 * boundary; a seat change is one tier either way.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from '../../db.ts'
import type { StripeClient } from '../../lib/billing/client.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import { seatLinesFromState } from '../../lib/billing/entitlements.ts'
import { type BillingGateway, resolveBillingGateway } from '../../lib/billing/gateway.ts'
import {
  deferredDeltasByTier,
  deferredIntentTargets,
  newDeferredIntent,
  type PendingIntent,
  withIntent,
  withoutIntents,
  writePendingChanges,
} from '../../lib/billing/pending-changes.ts'
import {
  type BillingQuantityLock,
  endQuantityMutation,
  tryBeginQuantityMutation,
} from '../../lib/billing/quantity-lock.ts'
import { mutateSubscription } from '../../lib/billing/schedules.ts'
import {
  clearSeatIncrease,
  newSeatIncreaseRecord,
  readSeatIncrease,
  seatIncreaseMatches,
  writeSeatIncrease,
} from '../../lib/billing/seat-increase.ts'
import { buildItemMutation, type TierDelta } from '../../lib/billing/subscriptions.ts'
import { priceMapWithIntentTargets, resolveTierPrice } from '../../lib/billing/tier-prices.ts'
import { getTierById, getTiersByIds, type TierRow } from '../../lib/db/tier-records.ts'
import { seatQuantitiesByTier } from '../../lib/db/billing-records.ts'
import { projectSubscriptionById } from '../../webhook/billing/stripe-projection.ts'
import {
  BILLING_MUTATION_IN_PROGRESS_ERROR,
  type BillingOrgView,
  coverageRefusal,
  hasLiveSubscription,
  loadBillingOrgView,
  NO_SUBSCRIPTION_ERROR,
  NOT_A_DOWNGRADE_ERROR,
  NOT_AN_UPGRADE_ERROR,
  TIER_NOT_PURCHASABLE_ERROR,
  tierChangeRefusal,
} from './routes-helpers.ts'

/** Every Postgres read, the lease, the gateway and the clock are injectable — the routes' seams, kept. */
export type BillingMutationDeps = Readonly<{
  db: Db
  client: StripeClient
  gateway?: BillingGateway
  loadView?: (db: Db, organizationId: string, nowMs: number) => Promise<BillingOrgView>
  beginMutation?: (db: Db, organizationId: string, nowMs: number) => Promise<BillingQuantityLock | null>
  endMutation?: (db: Db, lock: BillingQuantityLock) => Promise<void>
  nowMs?: () => number
}>

export type BillingRefusalStatus = 400 | 404 | 409

/** What a route sends back: the status and the JSON body, verbatim. */
export type BillingMutationOutcome<T extends Record<string, unknown>> =
  | { ok: true; status: 200; body: T }
  | { ok: false; status: BillingRefusalStatus; body: { error: string } & Record<string, unknown> }

export type ChangeSeatsInput = Readonly<{
  organizationId: string
  tierId: string
  /** Positive: immediate, invoiced now. Negative: deferred to the boundary. */
  delta: number
  /** The preview's pinned proration date; minted from `nowMs` when absent. */
  prorationDate?: number | null
}>

export type ChangeSeatsBody = {
  ok: true
  /** Stripe parked the raise under `pending_update`; entitlement is unchanged. */
  pending: boolean
  deferred: boolean
  scheduleId?: string | null
}

export type TierMoveInput = Readonly<{
  organizationId: string
  fromTierId: string
  toTierId: string
  /** Upgrades only. */
  prorationDate?: number | null
}>

export type UpgradeTierBody = { ok: true; pending: boolean }

export type DowngradeTierBody = { ok: true; deferred: true; intentId: string; scheduleId: string | null }

const INVALID_REQUEST = { error: 'Invalid request' } as const

function refuse(
  status: BillingRefusalStatus,
  body: { error: string } & Record<string, unknown>,
): BillingMutationOutcome<never> {
  return { ok: false, status, body }
}

function succeed<T extends Record<string, unknown>>(body: T): BillingMutationOutcome<T> {
  return { ok: true, status: 200, body }
}

function resolveDeps(deps: BillingMutationDeps) {
  return {
    gateway: deps.gateway ?? resolveBillingGateway(deps.client),
    loadView: deps.loadView ?? loadBillingOrgView,
    beginMutation: deps.beginMutation ?? tryBeginQuantityMutation,
    endMutation: deps.endMutation ?? endQuantityMutation,
    nowMs: deps.nowMs ?? (() => Date.now()),
  }
}

/** Run `work` under the organization's lease; `409` when it is held. */
async function underLease<T extends Record<string, unknown>>(
  deps: BillingMutationDeps,
  organizationId: string,
  work: (lock: BillingQuantityLock) => Promise<BillingMutationOutcome<T>>,
): Promise<BillingMutationOutcome<T>> {
  const { beginMutation, endMutation, nowMs } = resolveDeps(deps)
  const lock = await beginMutation(deps.db, organizationId, nowMs())
  if (!lock) return refuse(409, { error: BILLING_MUTATION_IN_PROGRESS_ERROR })
  try {
    return await work(lock)
  } finally {
    await endMutation(deps.db, lock).catch(() => {})
  }
}

/**
 * After a Stripe write: refetch the committed items, write the seats and
 * sync entitlements — under the lease we still hold, so the assignment
 * moves here and the webhook is a redundant confirmation.
 */
async function syncAfterMutation(
  deps: BillingMutationDeps,
  lock: BillingQuantityLock,
  providerSubscriptionId: string,
): Promise<void> {
  const { nowMs } = resolveDeps(deps)
  await projectSubscriptionById(
    { db: deps.db, client: deps.client, now: new Date(nowMs()).toISOString() },
    providerSubscriptionId,
    { lock },
  )
}

/**
 * A tier's rank as the seats, the catalogue, or the ledger know it. The
 * future mix the coverage gate evaluates includes every parked downgrade's
 * target, which may have no seat row yet — those rows are read here so the
 * resolver never comes up empty for a tier the ledger names.
 */
async function rankResolver(
  db: Db,
  view: BillingOrgView,
  extra: readonly TierRow[],
): Promise<(tierId: string) => number | undefined> {
  const ranks = new Map<string, number>()
  for (const seat of view.state.seats) ranks.set(seat.tierId, seat.tier.rank)
  for (const row of extra) ranks.set(row.id, row.rank)
  const missing = deferredIntentTargets(view.ledger).filter((tierId) => !ranks.has(tierId))
  for (const [id, row] of await getTiersByIds(db, missing)) ranks.set(id, row.rank)
  return (tierId) => ranks.get(tierId)
}

/** What both halves of a mutation share once the lease is held and the view is loaded. */
type MutationContext = {
  lock: BillingQuantityLock
  view: BillingOrgView
  sub: NonNullable<BillingOrgView['state']['subscription']>
  lines: ReturnType<typeof seatLinesFromState>['lines']
  priceByTier: ReturnType<typeof seatLinesFromState>['priceByTier']
}

/**
 * The immediate path, shared by a seat raise and an upgrade. Retry-safe:
 * the idempotency key and the exact parameters Stripe saw are persisted
 * (`seat-increase.ts`) **before** the call and reused by every retry of
 * the same deltas until the reprojection has landed. The record is dropped
 * once the reprojection succeeds, or when Stripe refuses permanently
 * (nothing was applied, so the next attempt is a new request).
 */
async function applyImmediate(
  deps: BillingMutationDeps,
  ctx: MutationContext,
  organizationId: string,
  deltas: readonly TierDelta[],
  prorationDate: number | null | undefined,
): Promise<{ pending: boolean } | BillingMutationOutcome<never>> {
  const { nowMs, gateway } = resolveDeps(deps)
  const { lock, view, sub, lines, priceByTier } = ctx
  let items
  try {
    items = buildItemMutation(lines, deltas, priceByTier)
  } catch {
    return refuse(400, INVALID_REQUEST)
  }
  // A retry of the same request replays the stored key *and* the stored
  // items and proration date — never the `items` rebuilt above, which a
  // webhook projecting the first attempt's own update can have moved;
  // anything else is a new request with a fresh record.
  const stored = await readSeatIncrease(deps.db, organizationId, sub.providerSubscriptionId, nowMs())
  const retry = stored && seatIncreaseMatches(stored, deltas) ? stored : null
  const record = retry ?? newSeatIncreaseRecord({
    providerSubscriptionId: sub.providerSubscriptionId,
    deltas,
    items,
    prorationDate: prorationDate ?? Math.floor(nowMs() / 1000),
    nowMs: nowMs(),
  })
  if (!retry) await writeSeatIncrease(deps.db, organizationId, record, nowMs())
  let result
  try {
    const fullPrices = await priceMapWithIntentTargets(deps.db, gateway, priceByTier, view.ledger)
    result = await mutateSubscription(deps.client, {
      kind: 'immediate',
      providerSubscriptionId: sub.providerSubscriptionId,
      scheduleId: sub.scheduleId,
      items: record.items,
      prorationDate: record.prorationDate,
      idempotencyKey: record.idempotencyKey,
      deferredDeltasByTier: deferredDeltasByTier(view.ledger),
      priceByTier: fullPrices,
      tierByPrice: new Map([...fullPrices].map(([t, p]) => [p, t])),
    })
  } catch (err) {
    // A permanent refusal applied nothing, so the record has nothing to
    // protect. A transient failure keeps it: Stripe may have applied the
    // update, and the retry must present the same key.
    if (err instanceof StripeApiError && err.classification === 'permanent') {
      await clearSeatIncrease(deps.db, organizationId)
    }
    throw err
  }
  await syncAfterMutation(deps, lock, sub.providerSubscriptionId)
  await clearSeatIncrease(deps.db, organizationId)
  return { pending: result.applied?.pending === true }
}

/**
 * The deferred path, shared by a seat release and a downgrade: the intents
 * are written first, the schedule's future phase is rebuilt from every
 * outstanding intent, and the intents are rolled back if Stripe refuses.
 */
async function applyDeferred(
  deps: BillingMutationDeps,
  ctx: MutationContext,
  organizationId: string,
  intents: readonly PendingIntent[],
): Promise<{ scheduleId: string | null }> {
  const { nowMs, gateway } = resolveDeps(deps)
  const { view, sub, lines, priceByTier } = ctx
  let ledger = view.ledger
  for (const intent of intents) ledger = withIntent(ledger, intent)
  await writePendingChanges(deps.db, organizationId, ledger, nowMs())
  try {
    return await mutateSubscription(deps.client, {
      kind: 'deferred',
      providerSubscriptionId: sub.providerSubscriptionId,
      scheduleId: sub.scheduleId,
      current: lines,
      deltasByTier: deferredDeltasByTier(ledger),
      priceByTier: await priceMapWithIntentTargets(deps.db, gateway, priceByTier, ledger),
      idempotencyKey: intents[0]!.idempotencyKey,
    })
  } catch (err) {
    // Roll the intents back: nothing was parked on the provider.
    await writePendingChanges(deps.db, organizationId, withoutIntents(ledger, intents.map((i) => i.id)), nowMs())
    throw err
  }
}

function isRefusal<T extends Record<string, unknown>>(
  value: T | BillingMutationOutcome<never>,
): value is BillingMutationOutcome<never> {
  return 'ok' in value && value.ok === false
}

/**
 * `POST /billing/seats`. An increase is immediate (`always_invoice`, under
 * `pending_if_incomplete`) and refused while delinquent; a decrease is a
 * `release-seat` intent per seat and a schedule phase at the boundary,
 * refused when the future mix would strand a licensed server or leave the
 * organization holding more licenses than it pays for.
 */
export async function changeSeats(
  deps: BillingMutationDeps,
  input: ChangeSeatsInput,
): Promise<BillingMutationOutcome<ChangeSeatsBody>> {
  const { loadView, nowMs, gateway } = resolveDeps(deps)
  const { organizationId, tierId, delta } = input
  if (!Number.isInteger(delta) || delta === 0) return refuse(400, INVALID_REQUEST)

  return await underLease(deps, organizationId, async (lock) => {
    const view = await loadView(deps.db, organizationId, nowMs())
    if (delta > 0) {
      const denied = tierChangeRefusal(view)
      if (denied) return refuse(409, denied)
    } else if (!hasLiveSubscription(view)) {
      return refuse(409, { error: NO_SUBSCRIPTION_ERROR })
    }
    const { lines, priceByTier } = seatLinesFromState(view.state)
    const sub = view.state.subscription!
    const ctx: MutationContext = { lock, view, sub, lines, priceByTier }

    if (delta > 0) {
      const price = await resolveTierPrice(deps.db, gateway, tierId)
      if (!price.ok) return refuse(400, { error: TIER_NOT_PURCHASABLE_ERROR, reason: price.reason, failures: price.failures ?? [] })
      priceByTier.set(tierId, price.providerPriceId)
      const applied = await applyImmediate(deps, ctx, organizationId, [{ tierId, delta }], input.prorationDate)
      if (isRefusal(applied)) return applied
      return succeed<ChangeSeatsBody>({ ok: true, pending: applied.pending, deferred: false })
    }

    const coverage = coverageRefusal(view, [{ tierId, delta }], await rankResolver(deps.db, view, []))
    if (coverage) return refuse(409, coverage)
    const fromQuantity = seatQuantitiesByTier(view.state).get(tierId) ?? 0
    if (fromQuantity + delta < 0) return refuse(400, INVALID_REQUEST)
    const intents: PendingIntent[] = []
    for (let i = 0; i < -delta; i += 1) {
      intents.push(newDeferredIntent('release-seat', {
        fromTierId: tierId,
        toTierId: null,
        landsAt: sub.currentPeriodEnd,
        fromQuantity,
        nowMs: nowMs(),
      }))
    }
    const result = await applyDeferred(deps, ctx, organizationId, intents)
    return succeed<ChangeSeatsBody>({ ok: true, pending: false, deferred: true, scheduleId: result.scheduleId })
  })
}

type ResolvedTierMove = { from: TierRow; to: TierRow }

/** Validate a tier move **before** the lease is taken: both tiers, and the direction. */
async function resolveTierMove(
  db: Db,
  input: TierMoveInput,
  direction: 'upgrade' | 'downgrade',
): Promise<ResolvedTierMove | BillingMutationOutcome<never>> {
  if (input.fromTierId === input.toTierId) return refuse(400, INVALID_REQUEST)
  const from = await getTierById(db, input.fromTierId)
  const to = await getTierById(db, input.toTierId)
  if (!from || !to) return refuse(400, INVALID_REQUEST)
  const higher = to.rank > from.rank
  if (direction === 'upgrade' && !higher) return refuse(400, { error: NOT_AN_UPGRADE_ERROR })
  if (direction === 'downgrade' && higher) return refuse(400, { error: NOT_A_DOWNGRADE_ERROR })
  return { from, to }
}

function isMoveRefusal(value: ResolvedTierMove | BillingMutationOutcome<never>): value is BillingMutationOutcome<never> {
  return 'ok' in value
}

/**
 * `POST /billing/upgrade`. One more at the higher tier and one fewer at the
 * lower, **now**: the item swap goes out under `pending_if_incomplete` and
 * the reprojection moves the assignment only when the committed items show
 * the change landed. `pending: true` means Stripe parked it; nothing has
 * moved yet. Refused while delinquent (C8), and when the lower tier has no
 * quantity to give.
 */
export async function upgradeTier(
  deps: BillingMutationDeps,
  input: TierMoveInput,
): Promise<BillingMutationOutcome<UpgradeTierBody>> {
  const { loadView, nowMs, gateway } = resolveDeps(deps)
  const move = await resolveTierMove(deps.db, input, 'upgrade')
  if (isMoveRefusal(move)) return move

  return await underLease(deps, input.organizationId, async (lock) => {
    const view = await loadView(deps.db, input.organizationId, nowMs())
    const denied = tierChangeRefusal(view)
    if (denied) return refuse(409, denied)
    const sub = view.state.subscription!
    const { lines, priceByTier } = seatLinesFromState(view.state)
    const price = await resolveTierPrice(deps.db, gateway, move.to.id)
    if (!price.ok) return refuse(400, { error: TIER_NOT_PURCHASABLE_ERROR, reason: price.reason, failures: price.failures ?? [] })
    priceByTier.set(move.to.id, price.providerPriceId)
    const deltas: TierDelta[] = [{ tierId: move.from.id, delta: -1 }, { tierId: move.to.id, delta: 1 }]
    // The swap never lowers coverage, but the lower tier must still have a
    // seat that is not already leaving at the boundary.
    const coverage = coverageRefusal(view, deltas, await rankResolver(deps.db, view, [move.from, move.to]))
    if (coverage) return refuse(409, coverage)
    const ctx: MutationContext = { lock, view, sub, lines, priceByTier }
    const applied = await applyImmediate(deps, ctx, input.organizationId, deltas, input.prorationDate)
    if (isRefusal(applied)) return applied
    return succeed<UpgradeTierBody>({ ok: true, pending: applied.pending })
  })
}

/**
 * `POST /billing/downgrade`. One fewer at the higher tier and one more at
 * the lower, parked as a `downgrade` intent and a schedule phase at
 * `current_period_end`. Refused when the future mix would strand a server
 * that needs the higher tier.
 */
export async function downgradeTier(
  deps: BillingMutationDeps,
  input: TierMoveInput,
): Promise<BillingMutationOutcome<DowngradeTierBody>> {
  const { loadView, nowMs, gateway } = resolveDeps(deps)
  const move = await resolveTierMove(deps.db, input, 'downgrade')
  if (isMoveRefusal(move)) return move

  return await underLease(deps, input.organizationId, async (lock) => {
    const view = await loadView(deps.db, input.organizationId, nowMs())
    if (!hasLiveSubscription(view)) return refuse(409, { error: NO_SUBSCRIPTION_ERROR })
    const sub = view.state.subscription!
    const { lines, priceByTier } = seatLinesFromState(view.state)
    const price = await resolveTierPrice(deps.db, gateway, move.to.id)
    if (!price.ok) return refuse(400, { error: TIER_NOT_PURCHASABLE_ERROR, reason: price.reason, failures: price.failures ?? [] })
    priceByTier.set(move.to.id, price.providerPriceId)
    const deltas: TierDelta[] = [{ tierId: move.from.id, delta: -1 }, { tierId: move.to.id, delta: 1 }]
    const coverage = coverageRefusal(view, deltas, await rankResolver(deps.db, view, [move.from, move.to]))
    if (coverage) return refuse(409, coverage)
    const intent = newDeferredIntent('downgrade', {
      fromTierId: move.from.id,
      toTierId: move.to.id,
      landsAt: sub.currentPeriodEnd,
      fromQuantity: seatQuantitiesByTier(view.state).get(move.from.id) ?? 0,
      nowMs: nowMs(),
    })
    const ctx: MutationContext = { lock, view, sub, lines, priceByTier }
    const result = await applyDeferred(deps, ctx, input.organizationId, [intent])
    return succeed<DowngradeTierBody>({ ok: true, deferred: true, intentId: intent.id, scheduleId: result.scheduleId })
  })
}
