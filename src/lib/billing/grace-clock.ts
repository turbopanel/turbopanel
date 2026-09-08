/**
 * The grace clock (C13): TurboPanel cancels what Stripe leaves past due.
 *
 * Stripe's dunning is configured in the Dashboard (Smart Retries over a
 * two-month window, end behaviour "leave past-due") — account settings,
 * not API fields — so a subscription that never recovers stays `past_due`
 * **forever** from Stripe's point of view. The projection latches
 * `grace_expires_at = past_due_since + BILLING_GRACE_WINDOW_MS` on the
 * first delinquent status; this sweep is what acts on it: a bounded batch
 * of subscriptions still delinquent past their expiry, each cancelled
 * through `cancelSubscription` (idempotent on `(subscription, expiry)`,
 * so a retried tick cannot double-cancel) and then reprojected so the
 * seats drop to zero and `applySeatEntitlements` revokes the licenses —
 * bound ones included, through the ended-subscription path.
 *
 * Leftover credit is forfeited. There is no refund call anywhere.
 *
 * Runs as an optional phase of the Workers maintenance cron (hosted only);
 * skipped entirely when billing is off.
 *
 * Workers-bundleable: nothing at module load.
 */

import type { Db } from '../../db.ts'
import { logError, logInfo } from '../../logger.ts'
import { listGraceExpiredSubscriptions, type SubscriptionRow } from '../db/billing-records.ts'
import type { StripeClient } from './client.ts'
import { StripeApiError } from './errors.ts'
import { cancelSubscription } from './subscriptions.ts'

export const GRACE_CLOCK_LOG_SCOPE = 'billing-grace-clock'

/** Subscriptions cancelled per tick — well under any subrequest budget. */
export const GRACE_CLOCK_BATCH_LIMIT = 25

/** The Workers cron runs the sweep on this minute-modulo divisor. */
export const GRACE_CLOCK_SWEEP_MINUTE_DIVISOR = 30

/** True on every Nth UTC minute (isolate-independent, no stored state). */
export function shouldRunGraceClock(scheduledTimeMs: number): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % GRACE_CLOCK_SWEEP_MINUTE_DIVISOR === 0
}

export type GraceClockDeps = Readonly<{
  db: Db
  client: StripeClient
  /** Reproject one subscription after its cancel; the webhook path's seam. */
  reproject: (providerSubscriptionId: string) => Promise<unknown>
  nowMs?: number
  limit?: number
}>

export type GraceClockResult = {
  scanned: number
  canceled: string[]
  failed: { providerSubscriptionId: string; error: string }[]
}

/** The maintenance tick: every grace-expired subscription in the database, up to the batch limit. */
export async function runGraceClock(deps: GraceClockDeps): Promise<GraceClockResult> {
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString()
  const rows = await listGraceExpiredSubscriptions(deps.db, nowIso, deps.limit ?? GRACE_CLOCK_BATCH_LIMIT)
  return await cancelGraceExpired(deps, rows)
}

export type ScopedGraceClockDeps = Omit<GraceClockDeps, 'limit'> & Readonly<{ providerSubscriptionId: string }>

/**
 * The same cancel-and-reproject step for **one** subscription, by provider
 * id — nothing else in the database is read or touched. This is what the
 * live harness (`scripts/billing-test-clock-harness.ts`) runs, because a
 * batch over a shared development database would cancel whatever other
 * delinquent rows happen to be there. `scanned` is `1` when the named
 * subscription is delinquent past its expiry at `nowMs`, else `0`; the
 * production tick never calls this.
 */
export async function runGraceClockForSubscription(deps: ScopedGraceClockDeps): Promise<GraceClockResult> {
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString()
  const rows = await listGraceExpiredSubscriptions(deps.db, nowIso, 1, {
    providerSubscriptionId: deps.providerSubscriptionId,
  })
  return await cancelGraceExpired(deps, rows)
}

async function cancelGraceExpired(
  deps: Pick<GraceClockDeps, 'client' | 'reproject'>,
  rows: readonly SubscriptionRow[],
): Promise<GraceClockResult> {
  const result: GraceClockResult = { scanned: rows.length, canceled: [], failed: [] }
  for (const row of rows) {
    const graceExpiresAt = row.graceExpiresAt
    if (!graceExpiresAt) continue
    try {
      await cancelSubscription(deps.client, {
        providerSubscriptionId: row.providerSubscriptionId,
        graceExpiresAt,
      })
      result.canceled.push(row.providerSubscriptionId)
      logInfo(
        GRACE_CLOCK_LOG_SCOPE,
        `subscription ${row.providerSubscriptionId}: grace expired ${graceExpiresAt}; cancelled`,
      )
    } catch (err) {
      // A subscription Stripe already cancelled is done — reproject to say so.
      const alreadyGone = err instanceof StripeApiError && err.status === 404
      if (!alreadyGone) {
        result.failed.push({ providerSubscriptionId: row.providerSubscriptionId, error: String(err) })
        logError(GRACE_CLOCK_LOG_SCOPE, `subscription ${row.providerSubscriptionId}: cancel failed: ${String(err)}`)
        continue
      }
    }
    try {
      await deps.reproject(row.providerSubscriptionId)
    } catch (err) {
      // The next `customer.subscription.deleted` delivery reprojects anyway.
      logError(GRACE_CLOCK_LOG_SCOPE, `subscription ${row.providerSubscriptionId}: reproject failed: ${String(err)}`)
    }
  }
  return result
}
