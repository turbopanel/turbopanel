/**
 * The entitlement boundary between a tier *label* and the capability plan.
 *
 * A tier row carries no entitlement columns any more — the label is the
 * key into `ladder.ts`, and this module is the one place that turns a
 * label (or a server's assigned tier rank) into
 * {@link MetricsCapabilityTierEntitlements}. `isEntryTier` is computed from
 * the ladder here so `capability-plan.ts` never names a priced label.
 */
import type { MetricsCapabilityTierEntitlements } from "../../daemon/metrics/capability-plan.ts";
import { ladderEntitlements, ladderEntryByRank } from "./ladder.ts";

export { ladderEntitlements as metricsCapabilityTierEntitlementsForLabel };

/** Entitlements for a `tier.rank`; `undefined` when the rank is null or off the ladder. */
export function metricsCapabilityTierEntitlementsForRank(
  rank: number | null | undefined,
): MetricsCapabilityTierEntitlements | undefined {
  return ladderEntitlements(ladderEntryByRank(rank)?.label);
}
