/**
 * Backend-neutral derived-value math for v4 chart/summary route responses —
 * the v4 analogue of `derived-metrics.ts`, generalized for v4's canonical-
 * name-keyed value maps instead of a fixed `HostMetricKey` union.
 *
 * Unlike v3 (which stores `cpuIdlePercent` and inverts it), v4's
 * `host.cpu.busyPercent` is already the "used" semantic, so
 * `cpuUsagePercent` is a direct passthrough — no `100 - idle` arithmetic.
 *
 * Every derivation is pure, `null`-propagating on any missing input or a
 * zero/negative denominator (same discipline as `sanitizeFinite` applies to
 * raw metrics), and consumed only at the route layer.
 */

export type DerivedHostValuesV4 = {
  cpuUsagePercent: number | null
  memoryUsedBytes: number | null
  memoryUsedPercent: number | null
  swapUsedPercent: number | null
  rootFilesystemUsedBytes: number | null
  rootFilesystemUsedPercent: number | null
}

/**
 * Host capacities needed to turn v4's "available"/"used" raw readings into
 * used-percent figures — sourced from the server's latest `TopologySnapshot`
 * (`memoryTotalBytes`/`swapTotalBytes`) plus the root-role filesystem's
 * `totalBytes` (`TopologyFilesystem` with `roles` including `"root"`).
 * `null` when the topology hasn't reported the figure yet.
 */
export type HostCapacitiesV4 = {
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

/** Compute all route-layer derived host values from a v4 canonical-name-keyed value map. */
export function computeDerivedHostValuesV4(
  values: Partial<Record<string, number | null>>,
  capacities: HostCapacitiesV4
): DerivedHostValuesV4 {
  const cpuUsagePercent = values['host.cpu.busyPercent'] ?? null

  const memoryAvailableBytes = values['host.memory.availableBytes'] ?? null
  const memoryUsedBytes = usedFromAvailable(capacities.memoryTotalBytes, memoryAvailableBytes)

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

export type IngressDerivedValuesV4 = {
  errorRatePercent: number | null
  averageLatencyMs: number | null
}

/**
 * Derived values for one `managed.ingress` entity's value map (bare field
 * names — `requests`, `responses4xx`, etc., matching
 * `EntitySeriesQueryV4`'s field-name convention for per-entity families).
 */
export function computeIngressDerivedValues(
  values: Partial<Record<string, number | null>>
): IngressDerivedValuesV4 {
  const requests = values.requests ?? null
  const responses4xx = values.responses4xx ?? null
  const responses5xx = values.responses5xx ?? null
  const errorRatePercent =
    requests === null || requests <= 0 || responses4xx === null || responses5xx === null
      ? null
      : ((responses4xx + responses5xx) / requests) * 100

  const requestDurationSecondsAvg = values.requestDurationSecondsAvg ?? null
  const averageLatencyMs =
    requestDurationSecondsAvg === null ? null : requestDurationSecondsAvg * 1000

  return { errorRatePercent, averageLatencyMs }
}
