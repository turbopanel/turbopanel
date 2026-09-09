/**
 * Derived tier assignment — which purchased tier each server sits on.
 *
 * An organization owns a quantity per tier (the `seat` rows). Each server
 * with an active license needs a tier from its hardware (`tier-placement`:
 * required = max(core band, RAM band)). Nobody chooses which server gets
 * which; this module computes it, and the result is cached on
 * `server.assigned_tier_id` by `assignment-records.ts`.
 *
 * The rule, spelled once:
 *
 *   1. Servers are taken **in bind order** (oldest first). An incumbent is
 *      placed before any newcomer, so adding hardware can never move a
 *      server that was covered onto nothing — the newcomer is the one left
 *      out. That is what makes "refuse the connect" honest: the server the
 *      gate names is the one that would go uncovered.
 *   2. Each server takes the **smallest** available tier whose rank is at
 *      least its requirement. Spare capacity above a server's need is fine
 *      (an upgrade looks like that between the immediate purchase and the
 *      boundary reduction), but a server is never parked on a bigger tier
 *      while a smaller one it fits would do.
 *   3. Unknown hardware (no resources reported yet) requires the entry
 *      rank: the server needs *a* tier, and the smallest will do until it
 *      says otherwise.
 *
 * Rank is a total order, so this greedy pass covers every server that any
 * assignment could cover for the given order; the coverage gate on every
 * reduction and deferred change runs the same function against the future
 * mix, so the two can never disagree.
 *
 * Pure: no I/O, no clock.
 */

import { ENTRY_TIER_RANK } from './ladder.ts'

export type TierQuantity = Readonly<{
  tierId: string
  rank: number
  quantity: number
}>

export type AssignableServer = Readonly<{
  serverId: string
  /** From `tier-placement`; `null` when hardware is not yet known. */
  requiredRank: number | null
  /** Bind order key: the server row's `created_at`. Ties break on id. */
  boundAt: string
}>

export type TierAssignment = Readonly<{
  /** `tierId` the server sits on, or `null` when nothing purchased covers it. */
  byServer: ReadonlyMap<string, string | null>
  /** Purchased quantity no server is using, per tier. */
  spare: ReadonlyMap<string, number>
  /** Servers in bind order that ended with no tier. */
  uncovered: readonly string[]
}>

export function effectiveRequiredRank(server: Pick<AssignableServer, 'requiredRank'>): number {
  return server.requiredRank ?? ENTRY_TIER_RANK
}

/** Bind order: oldest first, then id, so a recompute is stable. */
export function sortByBindOrder<T extends AssignableServer>(servers: readonly T[]): T[] {
  return [...servers].sort((a, b) => {
    const byBound = a.boundAt.localeCompare(b.boundAt)
    if (byBound !== 0) return byBound
    return a.serverId.localeCompare(b.serverId)
  })
}

export function computeAssignment(
  quantities: readonly TierQuantity[],
  servers: readonly AssignableServer[],
): TierAssignment {
  // Ascending rank so "smallest tier that fits" is the first hit.
  const pool = quantities
    .filter((entry) => entry.quantity > 0)
    .map((entry) => ({ ...entry, left: entry.quantity }))
    .sort((a, b) => a.rank - b.rank)

  const byServer = new Map<string, string | null>()
  const uncovered: string[] = []
  for (const server of sortByBindOrder(servers)) {
    const need = effectiveRequiredRank(server)
    const slot = pool.find((entry) => entry.left > 0 && entry.rank >= need)
    if (slot) {
      slot.left -= 1
      byServer.set(server.serverId, slot.tierId)
    } else {
      byServer.set(server.serverId, null)
      uncovered.push(server.serverId)
    }
  }
  const spare = new Map<string, number>()
  for (const entry of pool) spare.set(entry.tierId, entry.left)
  return { byServer, spare, uncovered }
}

/**
 * Would this mix leave a server uncovered that is covered today? The gate
 * every reduction and deferred change runs: `null` when the change is
 * safe, otherwise the first server (in bind order) it would strand.
 */
export function coverageLoss(
  current: readonly TierQuantity[],
  proposed: readonly TierQuantity[],
  servers: readonly AssignableServer[],
): { serverId: string; requiredRank: number } | null {
  const before = new Set(computeAssignment(current, servers).uncovered)
  const after = computeAssignment(proposed, servers)
  for (const serverId of after.uncovered) {
    if (before.has(serverId)) continue
    const server = servers.find((entry) => entry.serverId === serverId)
    return { serverId, requiredRank: server ? effectiveRequiredRank(server) : ENTRY_TIER_RANK }
  }
  return null
}

/** Apply per-tier deltas to a quantity list; tiers with no current row are created at rank `rankOf(tierId)`. */
export function applyTierDeltas(
  current: readonly TierQuantity[],
  deltas: ReadonlyMap<string, number>,
  rankOf: (tierId: string) => number | undefined,
): TierQuantity[] {
  const out = new Map<string, TierQuantity>()
  for (const entry of current) out.set(entry.tierId, entry)
  for (const [tierId, delta] of deltas) {
    const existing = out.get(tierId)
    const rank = existing?.rank ?? rankOf(tierId)
    if (rank === undefined) throw new TypeError(`tier ${tierId} has no rank`)
    const quantity = (existing?.quantity ?? 0) + delta
    if (quantity < 0) throw new RangeError(`tier ${tierId} would go to ${quantity}`)
    out.set(tierId, { tierId, rank, quantity })
  }
  return [...out.values()]
}
