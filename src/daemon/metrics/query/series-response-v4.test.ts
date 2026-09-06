import { assertEquals } from '@std/assert'
import type { HostSeriesResultV4 } from '../types-v4.ts'
import {
  computeSeriesGapCount,
  computeTopologyGenerationBreaks,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResultV4,
  toHostSeriesChartResponseV4,
} from './series-response-v4.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const EMPTY_CAPACITIES = {
  memoryTotalBytes: null,
  swapTotalBytes: null,
  rootFilesystemTotalBytes: null,
}

function availableResult(
  overrides: Partial<HostSeriesResultV4> = {},
): HostSeriesResultV4 {
  return {
    kind: 'duckdb',
    available: true,
    serverId: 'srv-1',
    metrics: ['host.cpu.busyPercent'],
    points: [],
    resolutionSeconds: 60,
    gapCount: 0,
    sampleCount: 0,
    ...overrides,
  }
}

test('defaultExpectedSamplesPerBucket falls back when the interval is not usable', () => {
  assertEquals(defaultExpectedSamplesPerBucket(60), 1)
  assertEquals(defaultExpectedSamplesPerBucket(60, 10), 6)
  assertEquals(defaultExpectedSamplesPerBucket(60, 0), 1)
  assertEquals(defaultExpectedSamplesPerBucket(60, Number.NaN), 1)
  assertEquals(defaultExpectedSamplesPerBucket(60, -5), 1)
})

test('computeSeriesGapCount returns 0 when the aligned range is empty', () => {
  const fromMs = Date.parse('2026-01-01T00:00:00.000Z')
  assertEquals(
    computeSeriesGapCount({
      fromMs,
      toMs: fromMs,
      resolutionSeconds: 60,
      points: [],
    }),
    0,
  )
  assertEquals(
    computeSeriesGapCount({
      fromMs,
      toMs: fromMs - 1,
      resolutionSeconds: 60,
      points: [],
    }),
    0,
  )
})

test('computeSeriesGapCount skips unparseable timestamps and counts missing buckets', () => {
  const fromMs = Date.parse('2026-01-01T00:00:00.000Z')
  const toMs = Date.parse('2026-01-01T00:03:00.000Z')
  const gaps = computeSeriesGapCount({
    fromMs,
    toMs,
    resolutionSeconds: 60,
    points: [
      { at: 'not-a-timestamp', sampleCount: 1 },
      { at: '2026-01-01T00:00:00.000Z', sampleCount: 1, expectedSampleCount: 1 },
    ],
  })
  assertEquals(gaps, 2)
})

test('finalizeHostSeriesResultV4 leaves unavailable or unparseable ranges unchanged', () => {
  const unavailable = availableResult({ available: false, resolutionSeconds: null })
  assertEquals(
    finalizeHostSeriesResultV4('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', unavailable),
    unavailable,
  )
  const missingResolution = availableResult({ resolutionSeconds: null })
  assertEquals(
    finalizeHostSeriesResultV4(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z',
      missingResolution,
    ),
    missingResolution,
  )
  const badRange = availableResult({ gapCount: 7 })
  assertEquals(
    finalizeHostSeriesResultV4('not-from', 'not-to', badRange),
    badRange,
  )
})

test('toHostSeriesChartResponseV4 maps points, derived values, and generation breaks', () => {
  const result = availableResult({
    points: [
      {
        at: '2026-01-01T00:00:00.000Z',
        values: { 'host.cpu.busyPercent': 10 },
        sampleCount: 1,
        expectedSampleCount: 1,
        topologyGeneration: 1,
        cpuHotspots: [{ coreId: '0', values: { busyPercent: 40 } }],
      },
      {
        at: '2026-01-01T00:01:00.000Z',
        values: { 'host.cpu.busyPercent': 20 },
        topologyGeneration: 2,
      },
    ],
    topologyGenerations: [1, 2],
    sampleCount: 2,
  })
  const response = toHostSeriesChartResponseV4({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:02:00.000Z',
    result,
    capacities: EMPTY_CAPACITIES,
  })
  assertEquals(response.ok, true)
  assertEquals(response.points.length, 2)
  assertEquals(response.points[0]?.derived.cpuUsagePercent, 10)
  assertEquals(response.points[0]?.expectedSampleCount, 1)
  assertEquals(response.points[0]?.topologyGeneration, 1)
  assertEquals(response.points[0]?.cpuHotspots?.[0]?.coreId, '0')
  assertEquals(response.topologyGenerationBreaks, [1])
  assertEquals(response.topologyGenerations, [1, 2])
})

test('computeTopologyGenerationBreaks ignores unknown generations', () => {
  assertEquals(
    computeTopologyGenerationBreaks([
      { topologyGeneration: null },
      { topologyGeneration: 1 },
      {},
      { topologyGeneration: 1 },
      { topologyGeneration: 3 },
    ]),
    [4],
  )
})
