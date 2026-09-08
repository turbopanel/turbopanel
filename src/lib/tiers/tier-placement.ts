/**
 * Required / recommended tier placement from already-collected hardware and
 * topology. Pure: no DB I/O, no priced-offering vocabulary (no prices, no
 * Stripe ids) — callers get a rank + label and a later phase is responsible
 * for binding or refusing against `license.tier_id`.
 *
 * Required = max(CPU cores, RAM). Recommended = max(required, monitored NIC /
 * drive / GPU counts). Hyperthreading never promotes: only
 * `cpus[].cores.total` is summed.
 */
import type { ServerHostResources } from "../db/server-metadata.ts";
import type { SlotMapping } from "../../client/servers/topology-types.ts";

export const TIER_BAND_LABELS = [
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
  "S7",
  "SX",
] as const;

export type TierBandLabel = (typeof TIER_BAND_LABELS)[number];

export type TierRank = {
  rank: number;
  label: TierBandLabel;
};

/** Rank of the entry offering within a generation (`tier.rank === 1`). */
export const ENTRY_TIER_RANK = 1;

const SX_LABEL: TierBandLabel = "SX";
const SX_TIER: TierRank = { rank: TIER_BAND_LABELS.length, label: SX_LABEL };

const GIBIBYTE = 1024 ** 3;

/** Physical-core ceilings: ≤4 / 10 / 16 / 32 / 64 / 128 / 256, else SX. */
export const TIER_CPU_CORE_THRESHOLDS = [4, 10, 16, 32, 64, 128, 256] as const;

/** RAM ceilings in bytes: ≤16 / 32 / 64 / 128 / 256 / 512 GiB / 1 TiB, else SX. */
export const TIER_RAM_BYTE_THRESHOLDS = [
  16 * GIBIBYTE,
  32 * GIBIBYTE,
  64 * GIBIBYTE,
  128 * GIBIBYTE,
  256 * GIBIBYTE,
  512 * GIBIBYTE,
  1024 * GIBIBYTE,
] as const;

/**
 * Soft NIC bands: the per-rank NIC-slot ceilings S1…S7 sell — ≤2 / 2 / 5 /
 * 5 / 8 / 8 / 11, else SX. One entry per rank, like the drive bands, and the
 * catalogue reads its `nicSlots` column from here, so the tier a NIC count
 * recommends is always one whose entitlement covers that count. The last
 * entry is the daemon's `MAX_NIC_SLOTS`: nothing above it can be monitored.
 */
export const TIER_NIC_SLOT_THRESHOLDS = [2, 2, 5, 5, 8, 8, 11] as const;

/** Soft drive bands: ≤2 / 4 / 6 / 8 / 12 / 16 / 20, else SX. */
export const TIER_DRIVE_SLOT_THRESHOLDS = [2, 4, 6, 8, 12, 16, 20] as const;

/** Soft GPU bands: ≤2 / 4 / 6 / 8, else SX. */
export const TIER_GPU_SLOT_THRESHOLDS = [2, 4, 6, 8] as const;

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
