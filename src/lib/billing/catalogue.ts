/**
 * The S1…S7 ladder and the SX negotiated tier — the **defaults the admin
 * tier form prefills**, and nothing more.
 *
 * Nothing here is written anywhere on its own. A superadmin creates the
 * Products and Prices in the Stripe Dashboard by hand and types the `tier`
 * rows in through `/api/admin/v1/tiers`; this module exists so the form,
 * the docs and the placement bands agree on what "S3" means before anyone
 * types it, and so the operator only has to supply the one field nothing
 * can derive for them — the Stripe price id.
 *
 * Cores and RAM ceilings are the placement thresholds in
 * `src/lib/tiers/tier-placement.ts`; the metrics entitlements and list
 * prices are the ladder `scripts/metrics-tier-model.ts` measured. Every
 * value here is a *row*, never an enum: a re-price is a new generation of
 * rows entered by hand, and the generation number lives in the `tier`
 * table, not here. NIC slots come from the placement bands too
 * (`TIER_NIC_SLOT_THRESHOLDS`, one ceiling per rank), so the tier a NIC
 * count recommends is always one that entitles that many slots, and the
 * top of the ladder is the daemon's `MAX_NIC_SLOTS` — a tier can never
 * sell a slot the daemon cannot monitor.
 *
 * What a row must satisfy on the Stripe side is `tier-verify.ts`, which
 * the admin route runs before writing and refuses on.
 *
 * Pure, Workers-bundleable: nothing at module load, no `@std/*`.
 */

import { MAX_NIC_SLOTS } from '../../client/servers/topology-types.ts'
import {
  TIER_CPU_CORE_THRESHOLDS,
  TIER_NIC_SLOT_THRESHOLDS,
  TIER_RAM_BYTE_THRESHOLDS,
} from '../tiers/tier-placement.ts'

/** Every priced tier is billed in this currency; `tier-verify.ts` refuses anything else. */
export const CATALOGUE_CURRENCY = 'usd'

/**
 * SX has no ceiling — it is negotiated per customer — but `max_cores` and
 * `max_memory_bytes` are `NOT NULL`. These sentinels are "unbounded" in the
 * only sense the columns can express: the largest value each will hold.
 */
export const SX_UNBOUNDED_CORES = 2_147_483_647
export const SX_UNBOUNDED_MEMORY_BYTES = Number.MAX_SAFE_INTEGER

export type CatalogueTier = Readonly<{
  label: string
  rank: number
  /** Null for SX: no list price, no Stripe Price. */
  priceCents: number | null
  isCustom: boolean
  maxCores: number
  maxMemoryBytes: number
  nicSlots: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
}>

function ladderCores(index: number): number {
  const value = TIER_CPU_CORE_THRESHOLDS[index]
  if (value === undefined) throw new RangeError(`no core threshold at rank ${index + 1}`)
  return value
}

function ladderMemory(index: number): number {
  const value = TIER_RAM_BYTE_THRESHOLDS[index]
  if (value === undefined) throw new RangeError(`no RAM threshold at rank ${index + 1}`)
  return value
}

function ladderNics(index: number): number {
  const value = TIER_NIC_SLOT_THRESHOLDS[index]
  if (value === undefined) throw new RangeError(`no NIC threshold at rank ${index + 1}`)
  if (value > MAX_NIC_SLOTS) throw new RangeError(`rank ${index + 1} sells ${value} NIC slots; the daemon monitors at most ${MAX_NIC_SLOTS}`)
  return value
}

type Entitlements = Readonly<{
  priceCents: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
}>

/**
 * Per-rank metrics entitlements and list price, from the measured ladder in
 * `scripts/metrics-tier-model.ts` (section 2). `nicSlots` is not spelled
 * here — it is the placement band (`ladderNics`), 2 / 2 / 5 / 5 / 8 / 8 / 11.
 * `filesystemSlots` is stored as the ladder says; the entry-tier carve-out to
 * `0` is applied in `capability-plan.ts` from `rank`, not baked into the row.
 */
const LADDER: readonly Entitlements[] = [
  { priceCents: 500, driveSlots: 2, gpuSlots: 2, filesystemSlots: 9 },
  { priceCents: 750, driveSlots: 4, gpuSlots: 2, filesystemSlots: 9 },
  { priceCents: 1000, driveSlots: 6, gpuSlots: 2, filesystemSlots: 9 },
  { priceCents: 1500, driveSlots: 8, gpuSlots: 4, filesystemSlots: 9 },
  { priceCents: 2000, driveSlots: 12, gpuSlots: 4, filesystemSlots: 18 },
  { priceCents: 3500, driveSlots: 16, gpuSlots: 6, filesystemSlots: 18 },
  { priceCents: 5000, driveSlots: 20, gpuSlots: 8, filesystemSlots: 18 },
]

function buildCatalogue(): readonly CatalogueTier[] {
  const priced = LADDER.map((row, index) => ({
    label: `S${index + 1}`,
    rank: index + 1,
    priceCents: row.priceCents,
    isCustom: false,
    maxCores: ladderCores(index),
    maxMemoryBytes: ladderMemory(index),
    nicSlots: ladderNics(index),
    driveSlots: row.driveSlots,
    gpuSlots: row.gpuSlots,
    filesystemSlots: row.filesystemSlots,
  }))
  const sx: CatalogueTier = {
    label: 'SX',
    rank: LADDER.length + 1,
    priceCents: null,
    isCustom: true,
    maxCores: SX_UNBOUNDED_CORES,
    maxMemoryBytes: SX_UNBOUNDED_MEMORY_BYTES,
    // SX watches every slot the daemon can monitor; nothing sells beyond it.
    nicSlots: MAX_NIC_SLOTS,
    driveSlots: 24,
    gpuSlots: 8,
    filesystemSlots: 18,
  }
  return [...priced, sx]
}

/** S1…S7 then SX, in rank order. Built on first call, never at module load. */
export function billingCatalogue(): readonly CatalogueTier[] {
  return buildCatalogue()
}
