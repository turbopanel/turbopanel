/**
 * Required / recommended tier placement from already-collected hardware and
 * topology. Pure: no DB I/O, no priced-offering vocabulary (no prices, no
 * Stripe ids) — callers get a rank + label and a later phase is responsible
 * for assigning or refusing against the purchased tiers (`assignment.ts`).
 *
 * Required = max(CPU cores, RAM). Recommended = max(required, monitored NIC /
 * drive / GPU counts). Hyperthreading never promotes: only
 * `cpus[].cores.total` is summed.
 */
import type { ServerHostResources } from "../db/server-metadata.ts";
import type { SlotMapping } from "../../client/servers/topology-types.ts";

import {
  CUSTOM_TIER_LABEL,
  LADDER,
  PRICED_LADDER,
  TIER_LABELS,
  type TierLabel,
} from "./ladder.ts";

/** S1…S7 then SX, in rank order — the ladder's labels. */
export const TIER_BAND_LABELS = TIER_LABELS;

export type TierBandLabel = TierLabel;

export type TierRank = {
  rank: number;
  label: TierBandLabel;
};

/** Rank of the entry offering (`tier.rank === 1`). */
export { ENTRY_TIER_RANK } from "./ladder.ts";

const SX_LABEL: TierBandLabel = CUSTOM_TIER_LABEL;
const SX_TIER: TierRank = { rank: LADDER.length, label: SX_LABEL };

/** Physical-core ceilings per priced rank: ≤4 / 10 / 16 / 32 / 64 / 128 / 256, else SX. */
export const TIER_CPU_CORE_THRESHOLDS: readonly number[] = PRICED_LADDER.map(
  (entry) => entry.maxCores,
);

/** RAM ceilings in bytes per priced rank: ≤16 / 32 / 64 / 128 / 256 / 512 GiB / 1 TiB, else SX. */
export const TIER_RAM_BYTE_THRESHOLDS: readonly number[] = PRICED_LADDER.map(
  (entry) => entry.maxMemoryBytes,
);

/**
 * Soft NIC bands: the per-rank NIC-slot ceilings S1…S7 sell — one entry per
 * rank, read from the ladder so the tier a NIC count recommends is always
 * one whose entitlement covers that count.
 */
export const TIER_NIC_SLOT_THRESHOLDS: readonly number[] = PRICED_LADDER.map(
  (entry) => entry.nicSlots,
);

/** Soft drive bands, from the ladder: ≤2 / 4 / 6 / 8 / 12 / 16 / 20, else SX. */
export const TIER_DRIVE_SLOT_THRESHOLDS: readonly number[] = PRICED_LADDER.map(
  (entry) => entry.driveSlots,
);

/**
 * Soft GPU bands: ≤2 / 4 / 6 / 8, else SX. The ladder repeats GPU counts
 * across neighbouring rungs, so the band is the *first* rank that sells a
 * given count — deduplicated here rather than spelled twice.
 */
export const TIER_GPU_SLOT_THRESHOLDS: readonly number[] = PRICED_LADDER.reduce<
  number[]
>((out, entry) => {
  if (out.at(-1) !== entry.gpuSlots) out.push(entry.gpuSlots);
  return out;
}, []);

function bandFromThresholds(
  value: number,
  thresholds: readonly number[],
): TierRank {
  for (let index = 0; index < thresholds.length; index++) {
    const threshold = thresholds[index];
    if (threshold === undefined || value > threshold) continue;
    const label = TIER_BAND_LABELS[index];
    if (label === undefined || label === SX_LABEL) break;
    return { rank: index + 1, label };
  }
  return SX_TIER;
}

function maxRank(left: TierRank, right: TierRank): TierRank {
  return left.rank >= right.rank ? left : right;
}

/**
 * Sum `cpus[].cores.total` across sockets. Threads are ignored — an 8c/16t
 * Xeon is 8 cores.
 */
export function totalPhysicalCores(resources: ServerHostResources): number {
  let total = 0;
  for (const cpu of resources.cpus ?? []) {
    const cores = cpu.cores?.total;
    if (typeof cores === "number" && Number.isFinite(cores) && cores > 0) {
      total += cores;
    }
  }
  return total;
}

export function cpuBand(cores: number): TierRank {
  return bandFromThresholds(cores, TIER_CPU_CORE_THRESHOLDS);
}

export function ramBand(memoryTotalBytes: number): TierRank {
  return bandFromThresholds(memoryTotalBytes, TIER_RAM_BYTE_THRESHOLDS);
}

export function nicBand(count: number): TierRank {
  return bandFromThresholds(count, TIER_NIC_SLOT_THRESHOLDS);
}

export function driveBand(count: number): TierRank {
  return bandFromThresholds(count, TIER_DRIVE_SLOT_THRESHOLDS);
}

export function gpuBand(count: number): TierRank {
  return bandFromThresholds(count, TIER_GPU_SLOT_THRESHOLDS);
}

/** Required tier is the harder of CPU and RAM. Topology counts never raise it. */
export function resolveRequiredTier(resources: ServerHostResources): TierRank {
  const memoryTotalBytes = resources.memory?.totalBytes ?? 0;
  return maxRank(
    cpuBand(totalPhysicalCores(resources)),
    ramBand(memoryTotalBytes),
  );
}

/**
 * Recommended tier is the harder of required and the monitored NIC / drive /
 * GPU counts. Reducing those counts can lower recommended, never required.
 *
 * `monitoredNicCount` is the operator's monitored set (the slot mapping's
 * `normalNicSlots` — the pinned list, or the default-route uplink), never
 * every uplink discovered: a six-port box watching one NIC is recommended by
 * that one NIC. Drives and GPUs have no operator selection and count what
 * was discovered.
 */
export function resolveRecommendedTier(
  resources: ServerHostResources,
  monitoredNicCount: number,
  monitoredDriveCount: number,
  monitoredGpuCount: number,
): TierRank {
  let recommended = resolveRequiredTier(resources);
  recommended = maxRank(recommended, nicBand(monitoredNicCount));
  recommended = maxRank(recommended, driveBand(monitoredDriveCount));
  return maxRank(recommended, gpuBand(monitoredGpuCount));
}

/**
 * Topology-derived monitored entity counts — the same `SlotMapping` ingest
 * and the UI already share, so placement never re-discovers devices.
 */
export function monitoredEntityCountsFromSlotMapping(
  mapping: Pick<
    SlotMapping,
    "normalNicSlots" | "blockPageOrder" | "gpuPageOrder"
  >,
): {
  monitoredNicCount: number;
  monitoredDriveCount: number;
  monitoredGpuCount: number;
} {
  return {
    monitoredNicCount: mapping.normalNicSlots.length,
    monitoredDriveCount: mapping.blockPageOrder.length,
    monitoredGpuCount: mapping.gpuPageOrder.length,
  };
}
