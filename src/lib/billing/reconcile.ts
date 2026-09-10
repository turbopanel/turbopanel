/**
 * The reconciliation sweep (C12): **alert, never auto-correct**.
 *
 * Per organization, compare what the provider says is paid for (the
 * `seat` quantities) against what this instance has handed out (active
 * licenses) and where its servers landed (the derived assignment). Drift
 * means Postgres entitlement no longer matches purchased seats — a mutation
 * landed without its confirmation, or a server's hardware outgrew what was
 * bought. This sweep does **not** refetch Stripe and is not recovery for a
 * missed webhook; unsettled Stripe events are retried by
 * `runPendingStripeProjections` on the maintenance tick. The honest answer
 * here is a structured error-level log plus the last report in a `setting`
 * row the admin surface can read.
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
} from '../db/billing-records.ts'
import { setting } from '../db/schema.ts'
import { countActiveLicenses } from '../db/tier-records.ts'
import { computeAssignment } from '../tiers/assignment.ts'
import { loadAssignableServers, tierQuantitiesFromState } from '../tiers/assignment-records.ts'
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
  /** More active licenses than purchased quantity — a mint slipped past the gate, or a reduction landed under held keys. */
  | 'licenses_exceed_purchased'
  /** A licensed server that no purchased tier covers — hardware outgrew the purchase. */
  | 'servers_uncovered'
  /** Purchased quantity no server or key is using. Informational. */
  | 'purchased_unused'

export type ReconcileDrift = Readonly<{
  organizationId: string
  kind: ReconcileDriftKind
  purchased: number
  /** Outstanding deferred releases across tiers, which explain a surplus. */
  releasing: number
  licensesHeld: number
  serversUncovered: readonly string[]
}>

export type ReconcileReport = Readonly<{
  ranAt: string
  organizations: number
  drift: readonly ReconcileDrift[]
}>

/**
 * Pure comparison for one organization. `purchased_unused` is reported at
 * info level only — an operator buying ahead is not drift — while the
 * other two kinds are the invariant breaking.
 */
export function compareSeatsToLicenses(input: {
  organizationId: string
  purchased: number
  releasing: number
  licensesHeld: number
  serversUncovered: readonly string[]
}): ReconcileDrift[] {
  const out: ReconcileDrift[] = []
  const base = {
    organizationId: input.organizationId,
    purchased: input.purchased,
    releasing: input.releasing,
    licensesHeld: input.licensesHeld,
    serversUncovered: [...input.serversUncovered],
  }
  if (input.serversUncovered.length > 0) out.push({ ...base, kind: 'servers_uncovered' })
  if (input.licensesHeld > input.purchased) out.push({ ...base, kind: 'licenses_exceed_purchased' })
  else if (input.purchased - input.releasing > input.licensesHeld) out.push({ ...base, kind: 'purchased_unused' })
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
    const licenses = await countActiveLicenses(deps.db, organizationId)
    const { ledger } = await readPendingChanges(deps.db, organizationId, state.subscription.providerSubscriptionId)
    const quantities = tierQuantitiesFromState(state)
    const servers = await loadAssignableServers(deps.db, organizationId)
    const assignment = computeAssignment(quantities, servers)
    let releasing = 0
    for (const count of outstandingReleasesByTier(ledger).values()) releasing += count
    drift.push(...compareSeatsToLicenses({
      organizationId,
      purchased: quantities.reduce((sum, entry) => sum + entry.quantity, 0),
      releasing,
      licensesHeld: licenses.active,
      serversUncovered: assignment.uncovered,
    }))
  }
  const report: ReconcileReport = {
    ranAt: new Date(nowMs).toISOString(),
    organizations: organizationIds.length,
    drift,
  }
  const broken = drift.filter((entry) => entry.kind !== 'purchased_unused')
  if (broken.length > 0) {
    logError(RECONCILE_LOG_SCOPE, 'purchase / license drift', JSON.stringify(broken))
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
