/**
 * The derived assignment, persisted: `server.assigned_tier_id`.
 *
 * `assignment.ts` is the rule; this is the read-compute-write around it.
 * It runs whenever either input can have changed — after every seat
 * projection and mutation (`entitlements.ts`), when a daemon reports its
 * hardware (`touchServerMetadata`), when a server enrolls or is deleted,
 * and when a license is revoked — and writes only the rows whose tier
 * moved. Everything on the ingest and page-load path then reads the cached
 * column; nothing there recomputes.
 *
 * Self-hosted never has a payer, but it does hold a grant
 * (`self-hosted-grant.ts`) — one `SX` unit per active license — so the
 * assignment runs there exactly as it does on the hosted runtime and
 * `server.assigned_tier_id` is populated on both. That is what lets a
 * control plane move between the two runtimes without its daemons being
 * refused.
 *
 * Workers-bundleable: nothing at module load.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import {
  getPayerForOrganization,
  isEndedStatus,
  listSeatsForOrganization,
  type OrganizationBillingState,
} from '../db/billing-records.ts'
import { license, server } from '../db/schema.ts'
import { parseServerHostResources, type ServerHostResources } from '../db/server-metadata.ts'
import {
  type AssignableServer,
  computeAssignment,
  type TierAssignment,
  type TierQuantity,
} from './assignment.ts'
import { resolveRequiredTier, totalPhysicalCores } from './tier-placement.ts'
import { selfHostedGrantRank } from './self-hosted-grant.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hardware is "known" once cores or bytes are reported; until then the entry rank is assumed. */
export function requiredRankFromResources(resources: ServerHostResources | undefined): number | null {
  if (!resources) return null
  const known = totalPhysicalCores(resources) > 0 || (resources.memory?.totalBytes ?? 0) > 0
  return known ? resolveRequiredTier(resources).rank : null
}

export function requiredRankFromMetadata(metadata: unknown): number | null {
  const record = isRecord(metadata) ? metadata : undefined
  return requiredRankFromResources(parseServerHostResources(record?.resources))
}

/**
 * Entitled quantity per tier with the tier's rank — the input to
 * {@link computeAssignment} and to every coverage gate.
 *
 * Two sources, added together. Projected provider seats read as zero once
 * the subscription ended, because entitlement follows the money. The
 * self-hosted grant (`self-hosted-grant.ts`) does not: it is not a
 * purchase, so no subscription status can end it, and a self-hosted
 * organization has no subscription at all. Both land at the tier they name,
 * so an organization holding a grant *and* provider seats at `SX` sums to
 * one quantity there rather than two entries.
 */
export function tierQuantitiesFromState(state: OrganizationBillingState): TierQuantity[] {
  const ended = !state.subscription || isEndedStatus(state.subscription.status)
  const out = new Map<string, TierQuantity>()
  const add = (tierId: string, rank: number, quantity: number) => {
    const existing = out.get(tierId)
    out.set(tierId, { tierId, rank, quantity: (existing?.quantity ?? 0) + quantity })
  }
  for (const seat of state.seats) {
    add(seat.tierId, seat.tier.rank, ended ? 0 : seat.quantity)
  }
  if (state.grant) {
    add(state.grant.tierId, selfHostedGrantRank(), state.grant.quantity)
  }
  return [...out.values()]
}

export type AssignedServerRow = AssignableServer & Readonly<{ assignedTierId: string | null }>

/** Every server in the organization holding an active license, with its requirement and current assignment. */
export async function loadAssignableServers(db: Db, organizationId: string): Promise<AssignedServerRow[]> {
  const rows = await db
    .select({
      serverId: server.id,
      createdAt: server.createdAt,
      metadata: server.metadata,
      assignedTierId: server.assignedTierId,
    })
    .from(server)
    .innerJoin(license, and(eq(license.serverId, server.id), isNull(license.revokedAt)))
    .where(eq(server.organizationId, organizationId))
  return rows.map((row) => ({
    serverId: row.serverId,
    boundAt: row.createdAt,
    requiredRank: requiredRankFromMetadata(row.metadata),
    assignedTierId: row.assignedTierId,
  }))
}

export type RecomputeAssignmentsResult = Readonly<{
  assignment: TierAssignment
  /** Server ids whose `assigned_tier_id` changed. */
  changed: readonly string[]
  /** Servers holding a license nothing purchased covers. */
  uncovered: readonly string[]
}>

export type RecomputeAssignmentsOpts = Readonly<{
  /** Already-loaded billing state, to skip the read. */
  state?: OrganizationBillingState
  now?: string
}>

/**
 * Recompute the organization's assignment from its committed seats and
 * its licensed servers, and write the rows that moved.
 */
export async function recomputeOrganizationAssignments(
  db: Db,
  organizationId: string,
  opts: RecomputeAssignmentsOpts = {},
): Promise<RecomputeAssignmentsResult> {
  const state = opts.state ?? await listSeatsForOrganization(db, organizationId)
  const servers = await loadAssignableServers(db, organizationId)
  const assignment = computeAssignment(tierQuantitiesFromState(state), servers)
  const now = opts.now ?? new Date().toISOString()
  const changed: string[] = []
  for (const row of servers) {
    const next = assignment.byServer.get(row.serverId) ?? null
    if (next === row.assignedTierId) continue
    await db
      .update(server)
      .set({ assignedTierId: next, updatedAt: now })
      .where(eq(server.id, row.serverId))
    changed.push(row.serverId)
  }
  return { assignment, changed, uncovered: assignment.uncovered }
}

/**
 * Recompute for the organization one server belongs to — the hook the
 * hardware-report and enroll paths call. A server with no organization,
 * or an organization with no payer (self-hosted, or hosted before the
 * first purchase), is a no-op beyond clearing a stale assignment.
 */
export async function recomputeAssignmentsForServer(
  db: Db,
  serverId: string,
): Promise<RecomputeAssignmentsResult | null> {
  const [row] = await db
    .select({ organizationId: server.organizationId, assignedTierId: server.assignedTierId })
    .from(server)
    .where(eq(server.id, serverId))
    .limit(1)
  if (!row?.organizationId) return null
  const payer = await getPayerForOrganization(db, row.organizationId)
  if (!payer) {
    if (row.assignedTierId !== null) {
      await db.update(server).set({ assignedTierId: null }).where(eq(server.id, serverId))
    }
    return null
  }
  return await recomputeOrganizationAssignments(db, row.organizationId)
}

/** Clear the assignment on servers that no longer hold a license (a revoke or delete path). */
export async function clearAssignmentsForServers(db: Db, serverIds: readonly string[]): Promise<void> {
  if (serverIds.length === 0) return
  await db
    .update(server)
    .set({ assignedTierId: null })
    .where(inArray(server.id, [...serverIds]))
}
