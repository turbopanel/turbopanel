/**
 * Entitlement sync: ledger in, `license.tier_id` moves out.
 *
 * Runs after every successful projection (the webhook task) and at the
 * end of every mutation route, so the webhook is a redundant idempotent
 * confirmation rather than the only path. It holds — or is handed — the
 * organization's quantity lease, reads the pending-change ledger, applies
 * the intents against the **committed** seats (`applySeatEntitlements`),
 * prunes what was consumed, and rebuilds the deferred schedule when the
 * ledger still carries deferred intents but the subscription has no
 * schedule (an upgrade released it and was parked as pending).
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from '../../db.ts'
import { logInfo, logWarn } from '../../logger.ts'
import {
  applySeatEntitlements,
  type ApplySeatEntitlementsResult,
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
} from '../db/billing-records.ts'
import { getTiersByIds } from '../db/tier-records.ts'
import type { StripeClient } from './client.ts'
import {
  deferredDeltasByTier,
  deferredIntents,
  type PendingChangeLedger,
  readPendingChanges,
  upgradeIntents,
  withoutIntents,
  writePendingChanges,
} from './pending-changes.ts'
import { type BillingQuantityLock, endQuantityMutation, tryBeginQuantityMutation } from './quantity-lock.ts'
import { syncDeferredSchedule } from './schedules.ts'
import type { SeatLine } from './subscriptions.ts'

export type EntitlementSyncDeps = Readonly<{
  db: Db
  /** Needed only to rebuild a released schedule; `null` skips that step. */
  client: StripeClient | null
  logScope?: string
  nowMs?: number
  onRevokeBound?: (serverId: string) => Promise<void>
  /** How long to wait for a held lease before skipping. */
  leaseRetry?: Readonly<{ attempts: number; delayMs: number }>
}>

/**
 * A route or the license gate holds the lease for one Stripe round trip;
 * a webhook landing meanwhile waits a few seconds rather than skipping.
 */
export const DEFAULT_LEASE_RETRY = { attempts: 4, delayMs: 1500 } as const

async function acquireLeaseWithRetry(
  db: Db,
  organizationId: string,
  nowMs: number,
  retry: Readonly<{ attempts: number; delayMs: number }>,
): Promise<BillingQuantityLock | null> {
  for (let attempt = 0; attempt < Math.max(1, retry.attempts); attempt += 1) {
    const lock = await tryBeginQuantityMutation(db, organizationId, nowMs + attempt * retry.delayMs)
    if (lock) return lock
    if (attempt + 1 < retry.attempts) {
      await new Promise((resolve) => setTimeout(resolve, retry.delayMs))
    }
  }
  return null
}

export type EntitlementSyncInput = Readonly<{
  organizationId: string
  providerSubscriptionId: string
  /** The refetched subscription carries a `pending_update`. */
  pendingUpdate: boolean
  /** `pending_update_expired`: the upgrade could not be paid; drop its intents. */
  dropUpgradeIntents?: boolean
  /** A lease the caller already holds; otherwise one is taken here. */
  lock?: BillingQuantityLock
  /** Already-loaded state, to skip the second read. */
  state?: OrganizationBillingState
}>

export type EntitlementSyncOutcome =
  | { action: 'synced'; result: ApplySeatEntitlementsResult; droppedUpgradeIntentIds: string[]; scheduleRebuilt: boolean }
  | { action: 'skipped'; reason: 'lease_held' }

/** Seat lines and the two price maps the schedule needs, from projected state. */
export function seatLinesFromState(state: OrganizationBillingState): {
  lines: SeatLine[]
  priceByTier: Map<string, string>
  tierByPrice: Map<string, string>
} {
  const lines: SeatLine[] = []
  const priceByTier = new Map<string, string>()
  const tierByPrice = new Map<string, string>()
  for (const seat of state.seats) {
    if (!seat.tier.providerPriceId) continue
    lines.push({
      providerItemId: seat.providerItemId,
      providerPriceId: seat.tier.providerPriceId,
      tierId: seat.tierId,
      quantity: seat.quantity,
    })
    priceByTier.set(seat.tierId, seat.tier.providerPriceId)
    tierByPrice.set(seat.tier.providerPriceId, seat.tierId)
  }
  return { lines, priceByTier, tierByPrice }
}

/** Price ids for every tier a ledger's deferred intents name, on top of the seats'. */
export async function priceMapWithIntentTargets(
  db: Db,
  priceByTier: Map<string, string>,
  ledger: PendingChangeLedger,
): Promise<Map<string, string>> {
  const missing = new Set<string>()
  for (const intent of deferredIntents(ledger)) {
    if (intent.toTierId && !priceByTier.has(intent.toTierId)) missing.add(intent.toTierId)
  }
  if (missing.size === 0) return priceByTier
  const out = new Map(priceByTier)
  for (const [id, row] of await getTiersByIds(db, [...missing])) {
    if (row.providerPriceId) out.set(id, row.providerPriceId)
  }
  return out
}

function dropExpiredUpgradeIntents(
  ledger: PendingChangeLedger,
  drop: boolean | undefined,
  logScope: string,
  organizationId: string,
): { ledger: PendingChangeLedger; droppedUpgradeIntentIds: string[] } {
  if (!drop) return { ledger, droppedUpgradeIntentIds: [] }
  const droppedUpgradeIntentIds = upgradeIntents(ledger).map((intent) => intent.id)
  if (droppedUpgradeIntentIds.length > 0) {
    logWarn(
      logScope,
      `organization ${organizationId}: pending update expired; ${droppedUpgradeIntentIds.length} upgrade intent(s) dropped — the console offers a retry`,
    )
  }
  return { ledger: withoutIntents(ledger, droppedUpgradeIntentIds), droppedUpgradeIntentIds }
}

/** An ended subscription has nothing left to defer. */
function clearLedgerIfSubscriptionEnded(
  ledger: PendingChangeLedger,
  state: OrganizationBillingState,
): PendingChangeLedger {
  if (!state.subscription || !isEndedStatus(state.subscription.status)) return ledger
  return { ...ledger, intents: [] }
}

async function rebuildDeferredScheduleIfNeeded(
  deps: EntitlementSyncDeps,
  input: EntitlementSyncInput,
  state: OrganizationBillingState,
  ledger: PendingChangeLedger,
  logScope: string,
): Promise<boolean> {
  const deltas = deferredDeltasByTier(ledger)
  const needsSchedule = [...deltas.values()].some((delta) => delta !== 0)
  const subscription = state.subscription
  if (
    !deps.client || !needsSchedule || input.pendingUpdate || !subscription ||
    subscription.scheduleId || isEndedStatus(subscription.status)
  ) {
    return false
  }
  const { lines, priceByTier } = seatLinesFromState(state)
  try {
    await syncDeferredSchedule(deps.client, {
      providerSubscriptionId: input.providerSubscriptionId,
      scheduleId: null,
      current: lines,
      deltasByTier: deltas,
      priceByTier: await priceMapWithIntentTargets(deps.db, priceByTier, ledger),
      // Keyed on the newest intent: fixed length (Stripe caps keys at 255).
      idempotencyKey: `${ledger.intents.at(-1)!.idempotencyKey}:rebuild`,
    })
    return true
  } catch (err) {
    // The intents survive in the ledger; the next mutation or sync retries.
    logWarn(logScope, `organization ${input.organizationId}: schedule rebuild failed: ${String(err)}`)
    return false
  }
}

function logEntitlementSyncResult(
  logScope: string,
  organizationId: string,
  result: ApplySeatEntitlementsResult,
): void {
  if (result.drift.length > 0) {
    logWarn(
      logScope,
      `organization ${organizationId}: seat drift only a bound license could close`,
      JSON.stringify(result.drift),
    )
    return
  }
  logInfo(logScope, `organization ${organizationId}: entitlements synced`, JSON.stringify(result))
}

export async function syncEntitlementsForOrganization(
  deps: EntitlementSyncDeps,
  input: EntitlementSyncInput,
): Promise<EntitlementSyncOutcome> {
  const logScope = deps.logScope ?? 'billing-entitlements'
  const nowMs = deps.nowMs ?? Date.now()
  const ownLock = input.lock
    ? null
    : await acquireLeaseWithRetry(deps.db, input.organizationId, nowMs, deps.leaseRetry ?? DEFAULT_LEASE_RETRY)
  if (!input.lock && !ownLock) {
    logWarn(
      logScope,
      `organization ${input.organizationId}: quantity lease held; entitlement sync deferred to the holder`,
    )
    return { action: 'skipped', reason: 'lease_held' }
  }
  try {
    const state = input.state ?? await listSeatsForOrganization(deps.db, input.organizationId)
    let { ledger } = await readPendingChanges(
      deps.db,
      input.organizationId,
      input.providerSubscriptionId,
      nowMs,
    )
    const dropped = dropExpiredUpgradeIntents(
      ledger,
      input.dropUpgradeIntents,
      logScope,
      input.organizationId,
    )
    ledger = dropped.ledger

    const result = await applySeatEntitlements(deps.db, input.organizationId, ledger.intents, {
      pendingUpdate: input.pendingUpdate,
      state,
      now: new Date(nowMs).toISOString(),
      onRevokeBound: deps.onRevokeBound,
    })
    ledger = withoutIntents(ledger, result.consumedIntentIds)
    ledger = clearLedgerIfSubscriptionEnded(ledger, state)
    await writePendingChanges(deps.db, input.organizationId, ledger, nowMs)

    const scheduleRebuilt = await rebuildDeferredScheduleIfNeeded(
      deps,
      input,
      state,
      ledger,
      logScope,
    )
    logEntitlementSyncResult(logScope, input.organizationId, result)
    return {
      action: 'synced',
      result,
      droppedUpgradeIntentIds: dropped.droppedUpgradeIntentIds,
      scheduleRebuilt,
    }
  } finally {
    if (ownLock) await endQuantityMutation(deps.db, ownLock).catch(() => {})
  }
}
