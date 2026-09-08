/**
 * Backend-neutral derived-value math for v5 chart/summary route responses —
 * the v5 analogue of `derived-metrics.ts`, generalized for v5's canonical-
 * name-keyed value maps instead of a fixed `HostMetricKey` union.
 *
 * Unlike v3 (which stores `cpuIdlePercent` and inverts it), v5's
 * `host.cpu.busyPercent` is already the "used" semantic, so
 * `cpuUsagePercent` is a direct passthrough — no `100 - idle` arithmetic.
 *
 * Every derivation is pure, `null`-propagating on any missing input or a
 * zero/negative denominator (same discipline as `sanitizeFinite` applies to
 * raw metrics), and consumed only at the route layer.
 */

export type DerivedHostValues = {
  cpuUsagePercent: number | null
  memoryUsedBytes: number | null
  memoryUsedPercent: number | null
  swapUsedPercent: number | null
  rootFilesystemUsedBytes: number | null
  rootFilesystemUsedPercent: number | null
}

/**
 * Host capacities needed to turn v5's "available"/"used" raw readings into
 * used-percent figures — sourced from the server's latest `TopologySnapshot`
 * (`memoryTotalBytes`/`swapTotalBytes`) plus the root-role filesystem's
 * `totalBytes` (`TopologyFilesystem` with `roles` including `"root"`).
 * `null` when the topology hasn't reported the figure yet.
 */
export type HostCapacities = {
  memoryTotalBytes: number | null
  swapTotalBytes: number | null
  rootFilesystemTotalBytes: number | null
}

function usedFromAvailable(
  totalBytes: number | null,
  availableBytes: number | null
): number | null {
  if (totalBytes === null || availableBytes === null) return null
  return totalBytes - availableBytes
}

function usedPercent(used: number | null, totalBytes: number | null): number | null {
  if (used === null || totalBytes === null || totalBytes <= 0) return null
  return (used / totalBytes) * 100
}

/** Compute all route-layer derived host values from a v5 canonical-name-keyed value map. */
export function computeDerivedHostValues(
  values: Partial<Record<string, number | null>>,
  capacities: HostCapacities
): DerivedHostValues {
  const cpuUsagePercent = values['host.cpu.busyPercent'] ?? null

  // v5 stores used memory directly (`MemTotal - MemAvailable`, computed on
  // the daemon) rather than the available side, so this is a passthrough —
  // v4 had to reconstruct it from the capacity, which silently rewrote
  // history whenever the host's RAM changed.
  const memoryUsedBytes = values['host.memory.usedBytes'] ?? null

  const swapUsedBytes = values['host.memory.swapUsedBytes'] ?? null

  const rootFilesystemAvailableBytes = values['host.storage.rootFilesystemAvailableBytes'] ?? null
  const rootFilesystemUsedBytes = usedFromAvailable(
    capacities.rootFilesystemTotalBytes,
    rootFilesystemAvailableBytes
  )

  return {
    cpuUsagePercent,
    memoryUsedBytes,
    memoryUsedPercent: usedPercent(memoryUsedBytes, capacities.memoryTotalBytes),
    swapUsedPercent: usedPercent(swapUsedBytes, capacities.swapTotalBytes),
    rootFilesystemUsedBytes,
    rootFilesystemUsedPercent: usedPercent(
      rootFilesystemUsedBytes,
      capacities.rootFilesystemTotalBytes
    ),
  }
}

export type IngressDerivedValues = {
  errorRatePercent: number | null
  averageLatencyMs: number | null
  p50LatencyMs: number | null
  p90LatencyMs: number | null
  p99LatencyMs: number | null
}

/**
 * `managed.ingress`'s cumulative-`le` latency buckets, in ascending bound
 * order, paired with that bound in milliseconds. `requests` is the implicit
 * `+Inf` bucket and is not listed here — {@link computeLatencyPercentileMs}
 * uses it as the total.
 *
 * These six bounds are what the daemon actually scrapes (Caddy's default
 * histogram set, and the `--metrics.prometheus.buckets` the deploy layer
 * configures), so they are the full resolution available: nothing finer than
 * 10ms and nothing between 1s and 5s exists to interpolate from.
 */
const INGRESS_LATENCY_BUCKETS: readonly { field: string; boundMs: number }[] = [
  { field: 'bucket10ms', boundMs: 10 },
  { field: 'bucket50ms', boundMs: 50 },
  { field: 'bucket100ms', boundMs: 100 },
  { field: 'bucket500ms', boundMs: 500 },
  { field: 'bucket1s', boundMs: 1000 },
  { field: 'bucket5s', boundMs: 5000 },
]

/**
 * `histogram_quantile`-style estimate from the cumulative bucket counters:
 * find the first bucket whose cumulative count reaches rank `q × total`, then
 * linearly interpolate within that bucket between its lower and upper bound.
 *
 * Two deliberate departures from a naive implementation:
 *
 * - Cumulative counts are clamped monotone before use. Each bucket is stored
 *   as an independent `delta-sum` series, and counter-reset clipping can leave
 *   a higher bucket with a *smaller* window total than a lower one — which
 *   would otherwise produce a negative bucket population and a nonsense
 *   interpolation.
 * - A rank beyond the last finite bucket returns that bucket's bound (5000ms)
 *   rather than extrapolating into the unbounded `+Inf` bucket, matching
 *   Prometheus. p999 is deliberately not offered anywhere: at six buckets
 *   topping out at 5s, the estimate would be dominated by that clamp and
 *   would report a confident number it cannot support.
 *
 * Returns `null` when the total is missing or non-positive, or when the
 * bucket the rank falls in has no reading.
 */
function computeLatencyPercentileMs(
  values: Partial<Record<string, number | null>>,
  total: number | null,
  quantile: number
): number | null {
  if (total === null || total <= 0) return null

  const cumulative: number[] = []
  let previous = 0
  for (const bucket of INGRESS_LATENCY_BUCKETS) {
    const raw = values[bucket.field] ?? null
    if (raw === null) return null
    previous = Math.max(previous, raw)
    cumulative.push(previous)
  }

  const rank = quantile * total
  let lowerBoundMs = 0
  let lowerCount = 0
  for (let i = 0; i < INGRESS_LATENCY_BUCKETS.length; i++) {
    const upperCount = cumulative[i]!
    const upperBoundMs = INGRESS_LATENCY_BUCKETS[i]!.boundMs
    if (upperCount >= rank) {
      const population = upperCount - lowerCount
      // A zero-population bucket cannot be interpolated through; the rank
      // sits exactly on its lower edge.
      if (population <= 0) return lowerBoundMs
      const fraction = (rank - lowerCount) / population
      return lowerBoundMs + fraction * (upperBoundMs - lowerBoundMs)
    }
    lowerBoundMs = upperBoundMs
    lowerCount = upperCount
  }
  // Beyond the last finite bound — report the bound, never an extrapolation.
  return INGRESS_LATENCY_BUCKETS.at(-1)!.boundMs
}

/**
 * Derived values for one `managed.ingress` entity's value map (bare field
 * names — `requests`, `responses4xx`, etc., matching
 * `EntitySeriesQuery`'s field-name convention for per-entity families).
 *
 * Both latency shapes are computed here rather than stored, because neither
 * aggregates: an average of per-interval averages is not the window average,
 * and a stored quantile cannot be re-bucketed at a coarser resolution. What
 * *is* stored — a raw duration sum and six cumulative bucket counters — adds
 * across windows, so a 5-minute and a 24-hour view derive from the identical
 * math.
 */
export function computeIngressDerivedValues(
  values: Partial<Record<string, number | null>>
): IngressDerivedValues {
  const requests = values.requests ?? null
  const responses4xx = values.responses4xx ?? null
  const responses5xx = values.responses5xx ?? null
  const errorRatePercent =
    requests === null || requests <= 0 || responses4xx === null || responses5xx === null
      ? null
      : ((responses4xx + responses5xx) / requests) * 100

  const requestDurationSecondsSum = values.requestDurationSecondsSum ?? null
  const averageLatencyMs =
    requestDurationSecondsSum === null || requests === null || requests <= 0
      ? null
      : (requestDurationSecondsSum / requests) * 1000

  return {
    errorRatePercent,
    averageLatencyMs,
    p50LatencyMs: computeLatencyPercentileMs(values, requests, 0.5),
    p90LatencyMs: computeLatencyPercentileMs(values, requests, 0.9),
    p99LatencyMs: computeLatencyPercentileMs(values, requests, 0.99),
  }
}
