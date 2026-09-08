/**
 * Chart-response shaping for `HostSeriesResult`.
 *
 * `computeSeriesGapCount` / `defaultExpectedSamplesPerBucket` are structurally
 * generic over `{ at, sampleCount?, expectedSampleCount? }`, so they live here
 * natively rather than duplicated per version — this module is their sole
 * home after the v3 cutover.
 */

import type { HostSeriesPoint, HostSeriesResult, MetricsBackendKind } from '../types.ts'
import { bucketFloor } from './buckets.ts'
import {
  computeDerivedHostValues,
  type DerivedHostValues,
  type HostCapacities,
} from './derived-metrics.ts'

/**
 * Expected samples per bucket. Buckets with data pass their observed average
 * collection interval so live (fast-cadence) sessions do not read as
 * over-full against a 60 s assumption; buckets with no points have no
 * observed interval and keep the baseline 60 s default.
 */
export function defaultExpectedSamplesPerBucket(
  resolutionSeconds: number,
  avgIntervalSeconds = 60
): number {
  const interval =
    Number.isFinite(avgIntervalSeconds) && avgIntervalSeconds > 0 ? avgIntervalSeconds : 60
  return Math.max(1, Math.round(resolutionSeconds / interval))
}

/**
 * Count fully missing buckets and partial buckets on the canonical grid.
 *
 * The range is half-open `[from, to)` on bucket starts after floor alignment.
 * Inclusive end would always expect the in-progress `to` bucket on live charts
 * (e.g. 1 h @ 60 s → 61 slots), so coverage could almost never hit 100%.
 */
export function computeSeriesGapCount(input: {
  fromMs: number
  toMs: number
  resolutionSeconds: number
  points: readonly {
    at: string
    sampleCount?: number
    expectedSampleCount?: number
  }[]
}): number {
  const bucketMs = input.resolutionSeconds * 1000
  const startMs = bucketFloor(input.fromMs, input.resolutionSeconds)
  const endMs = bucketFloor(input.toMs, input.resolutionSeconds)
  if (endMs <= startMs) return 0

  const pointByBucket = new Map<number, { sampleCount: number; expectedSampleCount: number }>()
  for (const point of input.points) {
    const atMs = Date.parse(point.at)
    if (!Number.isFinite(atMs)) continue
    const bucketStart = bucketFloor(atMs, input.resolutionSeconds)
    const expected =
      point.expectedSampleCount ?? defaultExpectedSamplesPerBucket(input.resolutionSeconds)
    const samples = point.sampleCount ?? 0
    pointByBucket.set(bucketStart, {
      sampleCount: samples,
      expectedSampleCount: expected,
    })
  }

  const defaultExpected = defaultExpectedSamplesPerBucket(input.resolutionSeconds)
  let gapCount = 0
  for (let bucket = startMs; bucket < endMs; bucket += bucketMs) {
    const existing = pointByBucket.get(bucket)
    if (!existing) {
      gapCount += defaultExpected
      continue
    }
    if (existing.sampleCount < existing.expectedSampleCount) {
      gapCount += existing.expectedSampleCount - existing.sampleCount
    }
  }
  return gapCount
}

export type HostSummaryChartResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  sampleCount: number
  latestAt: string | null
}

export type HostSeriesChartPoint = {
  at: string
  values: Partial<Record<string, number | null>>
  derived: DerivedHostValues
  sampleCount: number
  expectedSampleCount?: number
  topologyGeneration?: number | null
}

export type HostSeriesChartResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  resolutionSeconds: number | null
  backend: MetricsBackendKind
  available: boolean
  metrics: readonly string[]
  sampleCount: number
  gapCount: number
  points: HostSeriesChartPoint[]
  /**
   * Point indices where `topologyGeneration` differs from the previous known
   * generation — v5 analogue of v3's `generationBreaks`, renamed since v5
   * tracks topology generations rather than hardware-profile generations.
   * See {@link computeTopologyGenerationBreaks}.
   */
  topologyGenerationBreaks: number[]
  /** Distinct topology generations observed anywhere in the queried range — see `HostSeriesResult.topologyGenerations`. */
  topologyGenerations?: number[]
}

export function finalizeHostSeriesResult(
  from: string,
  to: string,
  result: HostSeriesResult
): HostSeriesResult {
  if (!result.available || result.resolutionSeconds === null) {
    return result
  }
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return result
  }
  return {
    ...result,
    gapCount: computeSeriesGapCount({
      fromMs,
      toMs,
      resolutionSeconds: result.resolutionSeconds,
      points: result.points,
    }),
  }
}

/**
 * v5 analogue of v3's `computeGenerationBreaks`, reading `topologyGeneration`
 * instead of `hardwareProfileGeneration` — same semantics: a `null`/`undefined`
 * entry is "unknown" and never itself a break, and the first point
 * establishing a known generation is never a break.
 */
export function computeTopologyGenerationBreaks(
  points: readonly { topologyGeneration?: number | null }[]
): number[] {
  const breaks: number[] = []
  let lastKnown: number | undefined
  for (let i = 0; i < points.length; i++) {
    const generation = points[i].topologyGeneration
    if (generation === null || generation === undefined) continue
    if (lastKnown !== undefined && generation !== lastKnown) {
      breaks.push(i)
    }
    lastKnown = generation
  }
  return breaks
}

export function toHostSeriesChartResponse(input: {
  serverId: string
  from: string
  to: string
  result: HostSeriesResult
  /** Fallback capacities — the latest recorded generation. */
  capacities: HostCapacities
  /**
   * Capacities that were true at each topology generation the range spans.
   * A bucket is divided by the totals its own generation had, so a RAM
   * upgrade or volume resize mid-range no longer restates history against
   * today's hardware. Points whose generation isn't in the map (or that
   * carry no generation at all) fall back to `capacities`.
   */
  capacitiesByGeneration?: ReadonlyMap<number, HostCapacities>
}): HostSeriesChartResponse {
  const result = finalizeHostSeriesResult(input.from, input.to, input.result)
  const capacitiesFor = (generation: number | null | undefined): HostCapacities =>
    (generation != null ? input.capacitiesByGeneration?.get(generation) : undefined) ??
    input.capacities
  const points: HostSeriesChartPoint[] = result.points.map((point: HostSeriesPoint) => ({
    at: point.at,
    values: point.values,
    derived: computeDerivedHostValues(point.values, capacitiesFor(point.topologyGeneration)),
    sampleCount: point.sampleCount ?? 0,
    ...(point.expectedSampleCount !== undefined
      ? { expectedSampleCount: point.expectedSampleCount }
      : {}),
    ...(point.topologyGeneration !== undefined
      ? { topologyGeneration: point.topologyGeneration }
      : {}),
  }))

  return {
    ok: true,
    serverId: input.serverId,
    from: input.from,
    to: input.to,
    resolutionSeconds: result.resolutionSeconds,
    backend: result.kind,
    available: result.available,
    metrics: result.metrics,
    sampleCount: result.sampleCount,
    gapCount: result.gapCount,
    points,
    topologyGenerationBreaks: computeTopologyGenerationBreaks(points),
    ...(result.topologyGenerations !== undefined
      ? { topologyGenerations: result.topologyGenerations }
      : {}),
  }
}
