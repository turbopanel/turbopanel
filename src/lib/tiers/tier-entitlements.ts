/**
 * Map a joined `tier` row onto {@link MetricsCapabilityTierEntitlements}.
 * `isEntryTier` is computed from `rank` here so `capability-plan.ts` never
 * hardcodes a priced-offering label.
 */
import type { MetricsCapabilityTierEntitlements } from "../../daemon/metrics/capability-plan.ts";
import { ENTRY_TIER_RANK } from "./tier-placement.ts";

export type TierEntitlementColumns = {
  nicSlots: number | null;
  driveSlots: number | null;
  gpuSlots: number | null;
  filesystemSlots: number | null;
  rank: number | null;
};

export function metricsCapabilityTierEntitlementsFromRow(
  row: TierEntitlementColumns | null | undefined,
): MetricsCapabilityTierEntitlements | undefined {
  if (
    row?.nicSlots == null ||
    row.driveSlots == null ||
    row.gpuSlots == null ||
    row.filesystemSlots == null ||
    row.rank == null
  ) {
    return undefined;
  }
  return {
    nicSlots: row.nicSlots,
    driveSlots: row.driveSlots,
    gpuSlots: row.gpuSlots,
    filesystemSlots: row.filesystemSlots,
    isEntryTier: row.rank === ENTRY_TIER_RANK,
  };
}
