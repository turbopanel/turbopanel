import { assertEquals } from '@std/assert'
import type { HostSeriesResultV5 } from '../types-v5.ts'
import {
  computeSeriesGapCount,
  computeTopologyGenerationBreaks,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResultV5,
  toHostSeriesChartResponseV5,
} from './series-response-v5.ts'

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

function availableResult(overrides: Partial<HostSeriesResultV5> = {}): HostSeriesResultV5 {
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
    0
  )
  assertEquals(
    computeSeriesGapCount({
      fromMs,
      toMs: fromMs - 1,
      resolutionSeconds: 60,
      points: [],
    }),
    0
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
      {
        at: '2026-01-01T00:00:00.000Z',
        sampleCount: 1,
        expectedSampleCount: 1,
      },
    ],
  })
  assertEquals(gaps, 2)
})

test('finalizeHostSeriesResultV5 leaves unavailable or unparseable ranges unchanged', () => {
  const unavailable = availableResult({
    available: false,
    resolutionSeconds: null,
  })
  assertEquals(
    finalizeHostSeriesResultV5('2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z', unavailable),
    unavailable
  )
  const missingResolution = availableResult({ resolutionSeconds: null })
  assertEquals(
    finalizeHostSeriesResultV5(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T01:00:00.000Z',
      missingResolution
    ),
    missingResolution
  )
  const badRange = availableResult({ gapCount: 7 })
  assertEquals(finalizeHostSeriesResultV5('not-from', 'not-to', badRange), badRange)
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
    [4]
  )
})

test('derived percentages use the capacities of each point’s own topology generation', () => {
  // A range spanning a RAM upgrade: generation 1 had 8 GB, generation 2 has
  // 16 GB. The same 6 GB reading is 75% before the upgrade and 37.5% after.
  // v4 divided every point by the *latest* capacity, so the pre-upgrade
  // history silently restated itself as 37.5%.
  const response = toHostSeriesChartResponseV5({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:02:00.000Z',
    result: availableResult({
      metrics: ['host.memory.usedBytes'],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: { 'host.memory.usedBytes': 6_000 },
          topologyGeneration: 1,
        },
        {
          at: '2026-01-01T00:01:00.000Z',
          values: { 'host.memory.usedBytes': 6_000 },
          topologyGeneration: 2,
        },
      ],
    }),
    capacities: {
      memoryTotalBytes: 16_000,
      swapTotalBytes: null,
      rootFilesystemTotalBytes: null,
    },
    capacitiesByGeneration: new Map([
      [
        1,
        {
          memoryTotalBytes: 8_000,
          swapTotalBytes: null,
          rootFilesystemTotalBytes: null,
        },
      ],
      [
        2,
        {
          memoryTotalBytes: 16_000,
          swapTotalBytes: null,
          rootFilesystemTotalBytes: null,
        },
      ],
    ]),
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, 75)
  assertEquals(response.points[1]!.derived.memoryUsedPercent, 37.5)
})

test('a point whose generation has no recorded snapshot falls back to the latest capacities', () => {
  const response = toHostSeriesChartResponseV5({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:01:00.000Z',
    result: availableResult({
      metrics: ['host.memory.usedBytes'],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: { 'host.memory.usedBytes': 4_000 },
          topologyGeneration: 99,
        },
      ],
    }),
    capacities: {
      memoryTotalBytes: 16_000,
      swapTotalBytes: null,
      rootFilesystemTotalBytes: null,
    },
    capacitiesByGeneration: new Map([
      [
        1,
        {
          memoryTotalBytes: 8_000,
          swapTotalBytes: null,
          rootFilesystemTotalBytes: null,
        },
      ],
    ]),
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, 25)
})

test('omitting capacitiesByGeneration keeps the previous single-capacity behaviour', () => {
  const response = toHostSeriesChartResponseV5({
    serverId: 'srv-1',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T00:01:00.000Z',
    result: availableResult({
      metrics: ['host.memory.usedBytes'],
      points: [
        {
          at: '2026-01-01T00:00:00.000Z',
          values: { 'host.memory.usedBytes': 4_000 },
          topologyGeneration: 1,
        },
      ],
    }),
    capacities: {
      memoryTotalBytes: 8_000,
      swapTotalBytes: null,
      rootFilesystemTotalBytes: null,
    },
  })
  assertEquals(response.points[0]!.derived.memoryUsedPercent, 50)
})
