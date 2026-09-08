/**
 * The reconciliation sweep (C12): **alert, never auto-correct**.
 *
 * Per tier per organization, compare `seat.quantity` (what the provider
 * says is paid for) against `countActiveLicensesByTier` (what this
 * instance has minted), and assert the quantity never falls below the
 * bound subset. Drift means a projection was missed — the webhook task
 * crashed after the ledger claim, or a mutation landed without its
 * confirmation — and the honest answer is a structured error-level log
 * plus the last report in a `setting` row the admin surface can read.
 *
 * No Stripe write, no license write. Correction is an operator's call.
 *
 * Runs as an optional phase of the Workers maintenance cron (hosted only);
 * skipped entirely when billing is off.
 *
 * Workers-bundleable: nothing at module load.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { logError, logInfo } from '../../logger.ts'
import {
  isEndedStatus,
  listOrganizationIdsWithPayer,
  listSeatsForOrganization,
  seatQuantitiesByTier,
} from '../db/billing-records.ts'
import { setting } from '../db/schema.ts'
import { countActiveLicensesByTier } from '../db/tier-records.ts'
import { outstandingReleasesByTier, readPendingChanges } from './pending-changes.ts'

export const RECONCILE_LOG_SCOPE = 'billing-reconcile'

/** The last report lives here for the admin surface. */
export const BILLING_RECONCILE_REPORT_KEY = 'BILLING_RECONCILE_REPORT'

/** The Workers cron runs the sweep on this minute-modulo divisor. */
export const RECONCILE_SWEEP_MINUTE_DIVISOR = 60

export function shouldRunReconcile(scheduledTimeMs: number): boolean {
  const minute = Math.floor(scheduledTimeMs / 60_000)
  return minute % RECONCILE_SWEEP_MINUTE_DIVISOR === 0
}

export type ReconcileDriftKind =
  | 'licenses_exceed_seats'
  | 'seats_below_bound'
  | 'seats_unused'

export type ReconcileDrift = Readonly<{
  organizationId: string
  tierId: string
  kind: ReconcileDriftKind
  seats: number
  active: number
  bound: number
  /** Outstanding `release-seat` intents at this tier, which explain a surplus. */
  outstandingReleases: number
}>

export type ReconcileReport = Readonly<{
  ranAt: string
  organizations: number
  drift: readonly ReconcileDrift[]
}>

/**
 * Pure comparison for one organization. `seatsUnused` is reported at
 * info level only — an operator buying ahead is not drift — while the
 * other two kinds are the invariant breaking.
 */
export function compareSeatsToLicenses(input: {
  organizationId: string
  seats: ReadonlyMap<string, number>
  counts: ReadonlyMap<string, { active: number; bound: number }>
  releases: ReadonlyMap<string, number>
}): ReconcileDrift[] {
  const out: ReconcileDrift[] = []
  const tierIds = new Set([...input.seats.keys(), ...input.counts.keys()])
  for (const tierId of tierIds) {
    const seats = input.seats.get(tierId) ?? 0
    const { active, bound } = input.counts.get(tierId) ?? { active: 0, bound: 0 }
    const outstandingReleases = input.releases.get(tierId) ?? 0
    const base = { organizationId: input.organizationId, tierId, seats, active, bound, outstandingReleases }
    if (seats < bound) out.push({ ...base, kind: 'seats_below_bound' })
    else if (active > seats) out.push({ ...base, kind: 'licenses_exceed_seats' })
    else if (seats - outstandingReleases > active) out.push({ ...base, kind: 'seats_unused' })
  }
  return out
}

export type ReconcileDeps = Readonly<{
  db: Db
  nowMs?: number
  /** Test seam: the organizations to scan. */
  organizationIds?: readonly string[]
}>

export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const nowMs = deps.nowMs ?? Date.now()
  const organizationIds = deps.organizationIds ?? await listOrganizationIdsWithPayer(deps.db)
  const drift: ReconcileDrift[] = []
  for (const organizationId of organizationIds) {
    const state = await listSeatsForOrganization(deps.db, organizationId)
    if (!state.subscription || isEndedStatus(state.subscription.status)) continue
    const counts = await countActiveLicensesByTier(deps.db, organizationId)
    const { ledger } = await readPendingChanges(
      deps.db,
      organizationId,
      state.subscription.providerSubscriptionId,
      nowMs,
    )
    drift.push(...compareSeatsToLicenses({
      organizationId,
      seats: seatQuantitiesByTier(state),
      counts,
      releases: outstandingReleasesByTier(ledger),
    }))
  }
  const report: ReconcileReport = {
    ranAt: new Date(nowMs).toISOString(),
    organizations: organizationIds.length,
    drift,
  }
  const broken = drift.filter((entry) => entry.kind !== 'seats_unused')
  if (broken.length > 0) {
    logError(RECONCILE_LOG_SCOPE, 'seat / license drift', JSON.stringify(broken))
  } else {
    logInfo(RECONCILE_LOG_SCOPE, `no drift across ${organizationIds.length} organization(s)`)
  }
  await writeReconcileReport(deps.db, report)
  return report
}

export async function writeReconcileReport(db: Db, report: ReconcileReport): Promise<void> {
  const now = report.ranAt
  const value = { ...report, drift: [...report.drift] }
  await db
    .insert(setting)
    .values({ key: BILLING_RECONCILE_REPORT_KEY, value, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } })
}

export async function readReconcileReport(db: Db): Promise<ReconcileReport | null> {
  const [row] = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, BILLING_RECONCILE_REPORT_KEY))
    .limit(1)
  const value = row?.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.ranAt !== 'string' || !Array.isArray(record.drift)) return null
  return {
    ranAt: record.ranAt,
    organizations: typeof record.organizations === 'number' ? record.organizations : 0,
    drift: record.drift as ReconcileDrift[],
  }
}
