/**
 * Per-family write cadence — the v5 cost lever.
 *
 * Analytics Engine bills per data point, and doubles inside a row are free.
 * So the only thing that ever saves money is not writing a row, or writing
 * it less often. Not every family needs 60-second resolution: free space on
 * a filesystem and a chassis inlet temperature do not move in 60 seconds,
 * and writing them at the same rate as CPU busy percent is pure waste.
 *
 * Decimation happens **at ingest, not on the daemon**. The daemon keeps
 * collecting every tick — collection is nearly free, the row is what costs —
 * and this module drops the families that aren't due. That preserves the
 * property that the daemon has no capability-plan awareness at all
 * (`capability-plan.ts`'s doc comment): everything the plan governs is
 * applied here, on the way into storage.
 *
 * The rule is stateless and deterministic — no per-server timer, no stored
 * cursor. A family is written when this sample crosses one of its tier
 * boundaries relative to the previous sample:
 *
 * ```
 * bucketFloor(sampledAt, tier) !== bucketFloor(sampledAt - interval, tier)
 * ```
 *
 * which means the same code handles both cadences: at the 60 s baseline a
 * 60-tier family writes every sample and a 300-tier family every fifth; in a
 * 10 s live session they write every sixth and every thirtieth. That is what
 * caps live-mode cost — a lease no longer multiplies every family by six,
 * only the `'every'` ones.
 *
 * **Eligibility is a semantic property, not a preference.** Only `gauge` and
 * `rate` families may be decimated. A `delta-sum` family stores raw
 * per-interval counts, so skipping a write does not coarsen it — it
 * *destroys* data. `managed.ingress` and `managed.database_proxy` are
 * delta-sum, which is why they are pinned to `'every'` here and must stay
 * that way. Events are discrete state transitions and are never dropped.
 */
import { bucketFloor } from './query/buckets.ts'
import type { MetricsSampleV5 } from './contract-v5.ts'
import type { SlotMapping } from './types-v5.ts'

/**
 * How often a family is written. `'every'` means every sample the daemon
 * sends; a number is the tier's period in seconds.
 */
export type MetricsCadenceTierV5 = 'every' | number

/** Slow tier: families whose value genuinely does not move within 5 minutes. */
export const METRICS_SLOW_TIER_SECONDS_V5 = 300

/** Fast tier: diagnostic families that stay at the baseline cadence but must not multiply during a live session. */
export const METRICS_FAST_TIER_SECONDS_V5 = 60

/**
 * Per-family cadence. Keyed by the `MetricsSampleV5` field the family is
 * derived from, so the mapping is checked against the contract by the
 * compiler rather than against AE's family strings.
 *
 * `host` is absent deliberately: `host.system` and `host.io` are the
 * mandatory baseline rows and are always written.
 */
export const METRICS_CADENCE_TIERS_V5: Readonly<
  Record<
    | 'networks'
    | 'filesystems'
    | 'blockDevices'
    | 'gpus'
    | 'hardwareSignals'
    | 'ingressSources'
    | 'databaseProxies'
    | 'cpuDetail'
    | 'memoryDetail'
    | 'numaNodes',
    MetricsCadenceTierV5
  >
> = {
  // Paged NIC rows (slots 3+). Slots 1-2 are embedded in the host.io row and
  // survive decimation regardless — see `keepEmbeddedNetworksOnly`.
  networks: METRICS_FAST_TIER_SECONDS_V5,
  // Per-drive throughput/latency is diagnostic: a slow disk is a 60-second
  // problem, not a 5-minute one.
  blockDevices: METRICS_FAST_TIER_SECONDS_V5,
  // Utilisation is bursty, and the row carries temperature/watts for free.
  gpus: METRICS_FAST_TIER_SECONDS_V5,

  // Free space and inode counts move on the order of minutes at most.
  filesystems: METRICS_SLOW_TIER_SECONDS_V5,
  // Board and inlet temperatures are trends. Thermal *events*
  // (`temp_alarm` / `temp_critical`) are still detected every tick on the
  // daemon and ride the never-decimated event path, so slowing the telemetry
  // does not slow the alarm.
  hardwareSignals: METRICS_SLOW_TIER_SECONDS_V5,
  // Both detail families are opt-in diagnostics, off by default.
  cpuDetail: METRICS_SLOW_TIER_SECONDS_V5,
  memoryDetail: METRICS_SLOW_TIER_SECONDS_V5,
  numaNodes: METRICS_SLOW_TIER_SECONDS_V5,

  // delta-sum families: raw per-interval counts. Decimating these would drop
  // requests and queries outright rather than coarsening them. Never change
  // these to a number without first converting the family to gauges.
  ingressSources: 'every',
  databaseProxies: 'every',
}

/**
 * Whether a tier is due on this sample.
 *
 * `intervalSeconds` is the daemon's own measured elapsed time, so this stays
 * correct across a dropped tick or a cadence switch: a sample that covers an
 * unusually long interval simply crosses more boundaries.
 */
export function cadenceTierIsDueV5(
  tier: MetricsCadenceTierV5,
  sampledAtMs: number,
  intervalSeconds: number
): boolean {
  if (tier === 'every') return true
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return true
  // An interval at least as long as the tier always spans a boundary.
  if (intervalSeconds >= tier) return true
  const previousMs = sampledAtMs - intervalSeconds * 1000
  return bucketFloor(sampledAtMs, tier) !== bucketFloor(previousMs, tier)
}

/**
 * The NIC entries that stay even when the `networks` tier isn't due: the two
 * slots `host.io` embeds, plus fabric devices, which are also folded into the
 * host row rather than paged. Dropping these would blank the host row's NIC
 * throughput on five ticks out of six in a live session.
 */
function keepEmbeddedNetworksOnly(
  networks: MetricsSampleV5['networks'],
  slotMapping: SlotMapping | undefined
): MetricsSampleV5['networks'] {
  if (!slotMapping) {
    // No identity resolution available — the field-map falls back to
    // positional embedding of networks[0]/networks[1], so keep exactly those.
    return networks.slice(0, 2)
  }
  const embedded = new Set<string>([
    ...slotMapping.normalNicSlots.slice(0, 2),
    ...slotMapping.fabricDeviceIds,
  ])
  return networks.filter((device) => embedded.has(device.deviceId))
}

/**
 * Drop every family that isn't due this sample.
 *
 * Pure: returns a new sample and never mutates the input. Applied after
 * `truncateSampleToCapabilityPlanV5` — the plan decides what a server is
 * *entitled* to store, this decides how often that entitlement is written.
 */
export function decimateSampleToCadenceTiersV5(
  sample: MetricsSampleV5,
  slotMapping?: SlotMapping
): MetricsSampleV5 {
  const sampledAtMs = Date.parse(sample.metadata.sampledAt)
  if (!Number.isFinite(sampledAtMs)) return sample
  const { intervalSeconds } = sample.metadata
  const due = (tier: MetricsCadenceTierV5) => cadenceTierIsDueV5(tier, sampledAtMs, intervalSeconds)

  const tiers = METRICS_CADENCE_TIERS_V5
  const decimated: MetricsSampleV5 = {
    ...sample,
    networks: due(tiers.networks)
      ? sample.networks
      : keepEmbeddedNetworksOnly(sample.networks, slotMapping),
    filesystems: due(tiers.filesystems) ? sample.filesystems : [],
    blockDevices: due(tiers.blockDevices) ? sample.blockDevices : [],
    gpus: due(tiers.gpus) ? sample.gpus : [],
    hardwareSignals: due(tiers.hardwareSignals) ? sample.hardwareSignals : [],
    ingressSources: due(tiers.ingressSources) ? sample.ingressSources : [],
    databaseProxies: due(tiers.databaseProxies) ? sample.databaseProxies : [],
  }
  if (sample.cpuDetail && !due(tiers.cpuDetail)) delete decimated.cpuDetail
  if (sample.memoryDetail && !due(tiers.memoryDetail)) {
    delete decimated.memoryDetail
  }
  if (sample.numaNodes && !due(tiers.numaNodes)) delete decimated.numaNodes
  return decimated
}
