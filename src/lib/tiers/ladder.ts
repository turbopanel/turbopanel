/**
 * The tier ladder — the one place that says what "S3" means.
 *
 * Every number a tier entitles or requires lives here, keyed by label:
 * the placement thresholds (`maxCores`, `maxMemoryBytes`), the monitoring
 * slot budgets (`nicSlots`, `driveSlots`, `gpuSlots`, `filesystemSlots`)
 * and the list price the Dashboard is expected to carry. The `tier` table
 * holds only what the code cannot know — which provider Product a label
 * bills against, and a cached display price — so a tier row is a label
 * plus a product id, and its entitlements are read from here by label.
 *
 * The daemon never sees a label; it receives a capability plan built from
 * these slot counts (`src/daemon/metrics/capability-plan.ts`). NIC slots
 * top out at the daemon's `MAX_NIC_SLOTS`, so no tier can sell a slot the
 * daemon cannot monitor — `ladder.test.ts` pins that.
 *
 * `rank` is the total order every comparison uses: upgrade versus
 * downgrade direction, the greedy server assignment
 * (`src/lib/tiers/assignment.ts`), and the placement bands. It is copied
 * onto the `tier` row on insert and never taken from a request.
 *
 * Pure, Workers-bundleable: nothing at module load beyond plain data.
 */

import type { MetricsCapabilityTierEntitlements } from '../../daemon/metrics/capability-plan.ts'
import { MAX_NIC_SLOTS } from '../../client/servers/topology-types.ts'

/** Every priced tier is billed in this currency; product verification refuses anything else. */
export const CATALOGUE_CURRENCY = 'usd'

/** Rank of the entry offering (`S1`). */
export const ENTRY_TIER_RANK = 1

/**
 * SX has no ceiling — it is negotiated per customer. These sentinels are
 * "unbounded" in the only sense a number can express: the largest value
 * each comparison will hold.
 */
export const SX_UNBOUNDED_CORES = 2_147_483_647
export const SX_UNBOUNDED_MEMORY_BYTES = Number.MAX_SAFE_INTEGER

export const TIER_LABELS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'SX'] as const

export type TierLabel = (typeof TIER_LABELS)[number]

export const CUSTOM_TIER_LABEL: TierLabel = 'SX'

export type LadderEntry = Readonly<{
  label: TierLabel
  rank: number
  /** True for the negotiated SX row: never purchasable through Checkout. */
  isCustom: boolean
  /** The list price the provider's Product is expected to carry; null for SX. */
  listPriceCents: number | null
  /** Placement ceiling: a server needs at least this tier when its physical cores exceed the previous ceiling. */
  maxCores: number
  /** Placement ceiling in bytes. */
  maxMemoryBytes: number
  nicSlots: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
}>

const GIB = 1024 ** 3

/**
 * S1…S7 then SX, in rank order. Slot budgets and list prices are the
 * measured ladder in `scripts/metrics-tier-model.ts`; the core / RAM
 * ceilings are the placement bands. `filesystemSlots` is stored as the
 * ladder says — the entry-tier carve-out to `0` is applied in
 * `capability-plan.ts` from `isEntryTier`, not baked in here.
 */
export const LADDER: readonly LadderEntry[] = [
  { label: 'S1', rank: 1, isCustom: false, listPriceCents: 500, maxCores: 4, maxMemoryBytes: 16 * GIB, nicSlots: 2, driveSlots: 2, gpuSlots: 2, filesystemSlots: 9 },
  { label: 'S2', rank: 2, isCustom: false, listPriceCents: 750, maxCores: 10, maxMemoryBytes: 32 * GIB, nicSlots: 2, driveSlots: 4, gpuSlots: 2, filesystemSlots: 9 },
  { label: 'S3', rank: 3, isCustom: false, listPriceCents: 1000, maxCores: 16, maxMemoryBytes: 64 * GIB, nicSlots: 5, driveSlots: 6, gpuSlots: 2, filesystemSlots: 9 },
  { label: 'S4', rank: 4, isCustom: false, listPriceCents: 1500, maxCores: 32, maxMemoryBytes: 128 * GIB, nicSlots: 5, driveSlots: 8, gpuSlots: 4, filesystemSlots: 9 },
  { label: 'S5', rank: 5, isCustom: false, listPriceCents: 2000, maxCores: 64, maxMemoryBytes: 256 * GIB, nicSlots: 8, driveSlots: 12, gpuSlots: 4, filesystemSlots: 18 },
  { label: 'S6', rank: 6, isCustom: false, listPriceCents: 3500, maxCores: 128, maxMemoryBytes: 512 * GIB, nicSlots: 8, driveSlots: 16, gpuSlots: 6, filesystemSlots: 18 },
  { label: 'S7', rank: 7, isCustom: false, listPriceCents: 5000, maxCores: 256, maxMemoryBytes: 1024 * GIB, nicSlots: 11, driveSlots: 20, gpuSlots: 8, filesystemSlots: 18 },
  // SX watches every slot the daemon can monitor; nothing sells beyond it.
  { label: 'SX', rank: 8, isCustom: true, listPriceCents: null, maxCores: SX_UNBOUNDED_CORES, maxMemoryBytes: SX_UNBOUNDED_MEMORY_BYTES, nicSlots: MAX_NIC_SLOTS, driveSlots: 24, gpuSlots: 8, filesystemSlots: 18 },
]

/** The priced rungs, S1…S7 — what the placement bands are cut from. */
export const PRICED_LADDER: readonly LadderEntry[] = LADDER.filter((entry) => !entry.isCustom)

export function isTierLabel(value: unknown): value is TierLabel {
  return typeof value === 'string' && (TIER_LABELS as readonly string[]).includes(value)
}

export function ladderEntry(label: string | null | undefined): LadderEntry | undefined {
  if (!label) return undefined
  return LADDER.find((entry) => entry.label === label)
}

export function ladderEntryByRank(rank: number | null | undefined): LadderEntry | undefined {
  if (rank == null) return undefined
  return LADDER.find((entry) => entry.rank === rank)
}

/** The rank a label carries, or `null` for a label not on the ladder. */
export function ladderRank(label: string | null | undefined): number | null {
  return ladderEntry(label)?.rank ?? null
}

/**
 * The monitoring entitlements a label grants, in the shape the capability
 * plan consumes. `undefined` for a label not on the ladder, which every
 * caller treats as "no tier" (the platform default plan).
 */
export function ladderEntitlements(
  label: string | null | undefined,
): MetricsCapabilityTierEntitlements | undefined {
  const entry = ladderEntry(label)
  if (!entry) return undefined
  return {
    nicSlots: entry.nicSlots,
    driveSlots: entry.driveSlots,
    gpuSlots: entry.gpuSlots,
    filesystemSlots: entry.filesystemSlots,
    isEntryTier: entry.rank === ENTRY_TIER_RANK,
  }
}
