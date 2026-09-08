/**
 * The billing mutations, as functions — what `routes.ts` answers with and
 * what the live harness (`scripts/billing-test-clock-harness.ts`) drives.
 *
 * Each one is the body of exactly one route (`POST /billing/seats`,
 * `/billing/upgrade`, `/billing/downgrade`) with the HTTP peeled off: it
 * validates, takes the organization's quantity lease, records the intent
 * in the ledger, calls `mutateSubscription`, reprojects under the same
 * lease, and returns the status and body the route sends verbatim. A
 * refusal is a value (`ok: false`), never a thrown error; a Stripe failure
 * is thrown as the `StripeApiError` it is, for the route to map with
 * `stripeErrorResponse` — the seat decrease rolls its intents back first.
 *
 * Having the gates here rather than in the route closures is what lets the
 * harness prove the real contract: an upgrade while `past_due` is refused
 * by the same code, with the same body, that the console sees.
 *
 * Workers-bundleable: nothing at module load.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type { StripeClient } from '../../lib/billing/client.ts'
import { StripeApiError } from '../../lib/billing/errors.ts'
import { priceMapWithIntentTargets, seatLinesFromState } from '../../lib/billing/entitlements.ts'
import {
  deferredDeltasByTier,
  intentForLicense,
  newDeferredIntent,
  newUpgradeIntent,
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
import { buildItemMutation } from '../../lib/billing/subscriptions.ts'
import { license } from '../../lib/db/schema.ts'
import { getTierById, resolvePurchasableTier } from '../../lib/db/tier-records.ts'
import { projectSubscriptionById } from '../../webhook/billing/stripe-projection.ts'
import {
  BILLING_MUTATION_IN_PROGRESS_ERROR,
  type BillingOrgView,
  freeSeatsAtTier,
  hasLiveSubscription,
  LICENSE_HAS_PENDING_CHANGE_ERROR,
  loadBillingOrgView,
  NOT_A_DOWNGRADE_ERROR,
  NOT_AN_UPGRADE_ERROR,
  SEATS_IN_USE_ERROR,
  SUBSCRIPTION_EXISTS_ERROR,
  TIER_NOT_PURCHASABLE_ERROR,
  tierChangeRefusal,
} from './routes-helpers.ts'

/** Every Postgres read, the lease, and the clock are injectable — the routes' seams, kept. */
export type BillingMutationDeps = Readonly<{
  db: Db
  client: StripeClient
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
  licenseId: string
  targetTierId: string
  /** Upgrades only. */
  prorationDate?: number | null
}>

export type UpgradeLicenseBody = { ok: true; pending: boolean; intentId: string }

export type DowngradeLicenseBody = { ok: true; deferred: true; intentId: string; scheduleId: string | null }

const INVALID_REQUEST = { error: 'Invalid request' } as const
const NOT_FOUND = { error: 'Not found' } as const

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

/** The unrevoked license's row, or `null` when the organization has no such license. */
export async function activeLicenseTier(
  db: Db,
  organizationId: string,
  licenseId: string,
): Promise<{ tierId: string | null } | null> {
  const [row] = await db
    .select({ tierId: license.tierId })
    .from(license)
    .where(and(eq(license.id, licenseId), eq(license.organizationId, organizationId), isNull(license.revokedAt)))
    .limit(1)
  return row ?? null
}

/**
 * After a Stripe write: refetch the committed items, write the seats and
 * sync entitlements — under the lease we still hold, so the intent is
 * consumed here and the webhook is a redundant confirmation. The seats in
 * Postgres are stale until this runs; a sync alone would see no room.
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
 * `POST /billing/seats`. An increase is immediate (`always_invoice`, under
 * `pending_if_incomplete`) and refused while delinquent; a decrease is a
 * `release-seat` intent per seat and a schedule phase at the boundary,
 * never below the licenses still counting at the tier.
 *
 * Both halves run under the lease with the same view and price map; see
 * `increaseSeats` for the retry contract of the immediate path.
 */
export async function changeSeats(
  deps: BillingMutationDeps,
  input: ChangeSeatsInput,
): Promise<BillingMutationOutcome<ChangeSeatsBody>> {
  const { loadView, nowMs } = resolveDeps(deps)
  const { organizationId, tierId, delta } = input
  if (!Number.isInteger(delta) || delta === 0) return refuse(400, INVALID_REQUEST)

  return await underLease(deps, organizationId, async (lock) => {
    const view = await loadView(deps.db, organizationId, nowMs())
    const denied = seatChangeRefusal(view, delta)
    if (denied) return refuse(409, denied)
    const { lines, priceByTier } = seatLinesFromState(view.state)
    const tier = await resolvePurchasableTier(deps.db, tierId)
    if (!tier.ok && delta > 0) {
      return refuse(400, { error: TIER_NOT_PURCHASABLE_ERROR, reason: tier.reason })
    }
    if (tier.ok) priceByTier.set(tierId, tier.tier.providerPriceId)
    // Both refusals above guarantee a subscription for the direction taken.
    const ctx: SeatChangeContext = { lock, view, sub: view.state.subscription!, lines, priceByTier }
    return delta > 0 ? await increaseSeats(deps, ctx, input) : await decreaseSeats(deps, ctx, input)
  })
}

/** What `changeSeats` refuses with before touching the tier: the C8 gate for a raise, a live subscription for a release. */
function seatChangeRefusal(view: BillingOrgView, delta: number): { error: string } | null {
  if (delta > 0) return tierChangeRefusal(view)
  return hasLiveSubscription(view) ? null : { error: SUBSCRIPTION_EXISTS_ERROR }
}

/** What both halves of `changeSeats` share once the lease is held and the view is loaded. */
type SeatChangeContext = {
  lock: BillingQuantityLock
  view: BillingOrgView
  sub: NonNullable<BillingOrgView['state']['subscription']>
  lines: ReturnType<typeof seatLinesFromState>['lines']
  priceByTier: ReturnType<typeof seatLinesFromState>['priceByTier']
}

/**
 * The immediate half of `changeSeats`. Retry-safe: its idempotency key and
 * the exact parameters Stripe saw are persisted (`seat-increase.ts`)
 * **before** the call and reused by every retry of the same
 * `(tierId, delta)` until the reprojection has landed — a failure after
 * Stripe accepted the update but before `syncAfterMutation` completed must
 * not buy the seats twice. The record is dropped once the reprojection
 * succeeds, or when Stripe refuses permanently (nothing was applied, so the
 * next attempt is a new request).
 */
async function increaseSeats(
  deps: BillingMutationDeps,
  ctx: SeatChangeContext,
  input: ChangeSeatsInput,
): Promise<BillingMutationOutcome<ChangeSeatsBody>> {
  const { nowMs } = resolveDeps(deps)
  const { organizationId, tierId, delta } = input
  const { lock, view, sub, lines, priceByTier } = ctx
  let items
  try {
    items = buildItemMutation(lines, [{ tierId, delta }], priceByTier)
  } catch {
    return refuse(400, INVALID_REQUEST)
  }
  // A retry of the same request replays the stored key *and* the stored
  // items and proration date — never the `items` rebuilt above, which a
  // webhook projecting the first attempt's own update can have moved;
  // anything else is a new request with a fresh record.
  const stored = await readSeatIncrease(deps.db, organizationId, sub.providerSubscriptionId, nowMs())
  const retry = stored && seatIncreaseMatches(stored, { tierId, delta }) ? stored : null
  const record = retry ?? newSeatIncreaseRecord({
    providerSubscriptionId: sub.providerSubscriptionId,
    tierId,
    delta,
    items,
    prorationDate: input.prorationDate ?? Math.floor(nowMs() / 1000),
    nowMs: nowMs(),
  })
  if (!retry) await writeSeatIncrease(deps.db, organizationId, record, nowMs())
  let result
  try {
    result = await mutateSubscription(deps.client, {
      kind: 'immediate',
      providerSubscriptionId: sub.providerSubscriptionId,
      scheduleId: sub.scheduleId,
      items: record.items,
      prorationDate: record.prorationDate,
      idempotencyKey: record.idempotencyKey,
      deferredDeltasByTier: deferredDeltasByTier(view.ledger),
      priceByTier: await priceMapWithIntentTargets(deps.db, priceByTier, view.ledger),
      tierByPrice: new Map([...priceByTier].map(([t, p]) => [p, t])),
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
  return succeed<ChangeSeatsBody>({ ok: true, pending: result.applied?.pending === true, deferred: false })
}

/** The deferred half of `changeSeats`: one `release-seat` intent per seat, rolled back if Stripe refuses. */
async function decreaseSeats(
  deps: BillingMutationDeps,
  ctx: SeatChangeContext,
  input: ChangeSeatsInput,
): Promise<BillingMutationOutcome<ChangeSeatsBody>> {
  const { nowMs } = resolveDeps(deps)
  const { organizationId, tierId, delta } = input
  const { view, sub, lines, priceByTier } = ctx
  // Never below the licenses still counting at the tier.
  const free = freeSeatsAtTier(view, tierId)
  const remove = -delta
  if (remove > free) {
    return refuse(409, { error: SEATS_IN_USE_ERROR, tierId, licensesFree: free })
  }
  let ledger = view.ledger
  const intents: PendingIntent[] = []
  for (let i = 0; i < remove; i += 1) {
    const intent = newDeferredIntent('release-seat', { licenseId: null, fromTierId: tierId, toTierId: null, nowMs: nowMs() })
    intents.push(intent)
    ledger = withIntent(ledger, intent)
  }
  await writePendingChanges(deps.db, organizationId, ledger, nowMs())
  try {
    const result = await mutateSubscription(deps.client, {
      kind: 'deferred',
      providerSubscriptionId: sub.providerSubscriptionId,
      scheduleId: sub.scheduleId,
      current: lines,
      deltasByTier: deferredDeltasByTier(ledger),
      priceByTier: await priceMapWithIntentTargets(deps.db, priceByTier, ledger),
      idempotencyKey: intents[0]!.idempotencyKey,
    })
    return succeed<ChangeSeatsBody>({ ok: true, pending: false, deferred: true, scheduleId: result.scheduleId })
  } catch (err) {
    // Roll the intents back: nothing was parked on the provider.
    await writePendingChanges(deps.db, organizationId, withoutIntents(ledger, intents.map((i) => i.id)), nowMs())
    throw err
  }
}

type ResolvedTierMove = { licenseId: string; fromTierId: string; targetTierId: string; targetPriceId: string }

/** Validate a tier move **before** the lease is taken: the license, the target, the direction. */
async function resolveTierMove(
  db: Db,
  input: TierMoveInput,
  direction: 'upgrade' | 'downgrade',
): Promise<ResolvedTierMove | BillingMutationOutcome<never>> {
  const { organizationId, licenseId, targetTierId } = input
  const active = await activeLicenseTier(db, organizationId, licenseId)
  if (!active) return refuse(404, NOT_FOUND)
  const from = active.tierId
  if (!from || from === targetTierId) return refuse(400, INVALID_REQUEST)
  const target = await resolvePurchasableTier(db, targetTierId)
  if (!target.ok) return refuse(400, { error: TIER_NOT_PURCHASABLE_ERROR, reason: target.reason })
  const source = await getTierById(db, from)
  if (!source) return refuse(400, INVALID_REQUEST)
  const higher = target.tier.generation > source.generation ||
    (target.tier.generation === source.generation && target.tier.rank > source.rank)
  if (direction === 'upgrade' && !higher) return refuse(400, { error: NOT_AN_UPGRADE_ERROR })
  if (direction === 'downgrade' && higher) return refuse(400, { error: NOT_A_DOWNGRADE_ERROR })
  return { licenseId, fromTierId: from, targetTierId, targetPriceId: target.tier.providerPriceId }
}

function isRefusal(value: ResolvedTierMove | BillingMutationOutcome<never>): value is BillingMutationOutcome<never> {
  return 'ok' in value
}

/**
 * `POST /billing/upgrade`. Refused while delinquent (C8); otherwise an
 * `upgrade` intent is recorded, the item swap goes out under
 * `pending_if_incomplete`, and the reprojection moves `license.tier_id`
 * only when the committed items show the change landed. `pending: true`
 * means Stripe parked it: the license stays where it was until
 * `pending_update_applied`.
 */
export async function upgradeLicense(
  deps: BillingMutationDeps,
  input: TierMoveInput,
): Promise<BillingMutationOutcome<UpgradeLicenseBody>> {
  const { loadView, nowMs } = resolveDeps(deps)
  const move = await resolveTierMove(deps.db, input, 'upgrade')
  if (isRefusal(move)) return move

  return await underLease(deps, input.organizationId, async (lock) => {
    const view = await loadView(deps.db, input.organizationId, nowMs())
    const denied = tierChangeRefusal(view)
    if (denied) return refuse(409, denied)
    const sub = view.state.subscription!
    const existing = intentForLicense(view.ledger, move.licenseId)
    if (existing && (existing.kind !== 'upgrade' || existing.toTierId !== move.targetTierId)) {
      return refuse(409, { error: LICENSE_HAS_PENDING_CHANGE_ERROR, intent: existing })
    }
    // A retry of the same upgrade reuses the intent — and its idempotency key.
    const intent = existing ?? newUpgradeIntent({
      licenseId: move.licenseId,
      fromTierId: move.fromTierId,
      toTierId: move.targetTierId,
      nowMs: nowMs(),
    })
    const ledger = withIntent(view.ledger, intent)
    await writePendingChanges(deps.db, input.organizationId, ledger, nowMs())

    const { lines, priceByTier } = seatLinesFromState(view.state)
    priceByTier.set(move.targetTierId, move.targetPriceId)
    let items
    try {
      items = buildItemMutation(
        lines,
        [{ tierId: move.fromTierId, delta: -1 }, { tierId: move.targetTierId, delta: 1 }],
        priceByTier,
      )
    } catch {
      return refuse(400, INVALID_REQUEST)
    }
    const fullPrices = await priceMapWithIntentTargets(deps.db, priceByTier, ledger)
    const result = await mutateSubscription(deps.client, {
      kind: 'immediate',
      providerSubscriptionId: sub.providerSubscriptionId,
      scheduleId: sub.scheduleId,
      items,
      prorationDate: input.prorationDate ?? Math.floor(nowMs() / 1000),
      idempotencyKey: intent.idempotencyKey,
      deferredDeltasByTier: deferredDeltasByTier(ledger),
      priceByTier: fullPrices,
      tierByPrice: new Map([...fullPrices].map(([t, p]) => [p, t])),
    })
    const pending = result.applied?.pending === true
    await syncAfterMutation(deps, lock, sub.providerSubscriptionId)
    return succeed<UpgradeLicenseBody>({ ok: true, pending, intentId: intent.id })
  })
}

/**
 * `POST /billing/downgrade`. A `downgrade` intent naming the license, and
 * a schedule phase at `current_period_end` — the seats and the license
 * stay where they are until the boundary lands and the projection consumes
 * the intent.
 */
export async function downgradeLicense(
  deps: BillingMutationDeps,
  input: TierMoveInput,
): Promise<BillingMutationOutcome<DowngradeLicenseBody>> {
  const { loadView, nowMs } = resolveDeps(deps)
  const move = await resolveTierMove(deps.db, input, 'downgrade')
  if (isRefusal(move)) return move

  return await underLease(deps, input.organizationId, async () => {
    const view = await loadView(deps.db, input.organizationId, nowMs())
    if (!hasLiveSubscription(view)) return refuse(409, { error: SUBSCRIPTION_EXISTS_ERROR })
    const sub = view.state.subscription!
    const existing = intentForLicense(view.ledger, move.licenseId)
    if (existing && (existing.kind !== 'downgrade' || existing.toTierId !== move.targetTierId)) {
      return refuse(409, { error: LICENSE_HAS_PENDING_CHANGE_ERROR, intent: existing })
    }
    const intent = existing ?? newDeferredIntent('downgrade', {
      licenseId: move.licenseId,
      fromTierId: move.fromTierId,
      toTierId: move.targetTierId,
      nowMs: nowMs(),
    })
    const ledger = withIntent(view.ledger, intent)
    await writePendingChanges(deps.db, input.organizationId, ledger, nowMs())

    const { lines, priceByTier } = seatLinesFromState(view.state)
    priceByTier.set(move.targetTierId, move.targetPriceId)
    try {
      const result = await mutateSubscription(deps.client, {
        kind: 'deferred',
        providerSubscriptionId: sub.providerSubscriptionId,
        scheduleId: sub.scheduleId,
        current: lines,
        deltasByTier: deferredDeltasByTier(ledger),
        priceByTier: await priceMapWithIntentTargets(deps.db, priceByTier, ledger),
        idempotencyKey: intent.idempotencyKey,
      })
      return succeed<DowngradeLicenseBody>({ ok: true, deferred: true, intentId: intent.id, scheduleId: result.scheduleId })
    } catch (err) {
      if (!existing) {
        await writePendingChanges(deps.db, input.organizationId, withoutIntents(ledger, [intent.id]), nowMs())
      }
      throw err
    }
  })
}
