import { assertEquals } from '@std/assert'
import {
  computeDerivedHostValues,
  computeIngressDerivedValues,
  type HostCapacities,
} from './derived-metrics.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const EMPTY_CAPACITIES: HostCapacities = {
  memoryTotalBytes: null,
  swapTotalBytes: null,
  rootFilesystemTotalBytes: null,
}

test('computeDerivedHostValues passes cpu busy through and derives used percents', () => {
  const derived = computeDerivedHostValues(
    {
      'host.cpu.busyPercent': 37.5,
      'host.memory.usedBytes': 6_000,
      'host.memory.swapUsedBytes': 250,
      'host.storage.rootFilesystemAvailableBytes': 4_000,
    },
    {
      memoryTotalBytes: 8_000,
      swapTotalBytes: 1_000,
      rootFilesystemTotalBytes: 10_000,
    }
  )
  assertEquals(derived.cpuUsagePercent, 37.5)
  assertEquals(derived.memoryUsedBytes, 6_000)
  assertEquals(derived.memoryUsedPercent, 75)
  assertEquals(derived.swapUsedPercent, 25)
  assertEquals(derived.rootFilesystemUsedBytes, 6_000)
  assertEquals(derived.rootFilesystemUsedPercent, 60)
})

test('computeDerivedHostValues propagates nulls and rejects a non-positive total', () => {
  const missing = computeDerivedHostValues({}, EMPTY_CAPACITIES)
  assertEquals(missing, {
    cpuUsagePercent: null,
    memoryUsedBytes: null,
    memoryUsedPercent: null,
    swapUsedPercent: null,
    rootFilesystemUsedBytes: null,
    rootFilesystemUsedPercent: null,
  })

  const zeroTotal = computeDerivedHostValues(
    {
      'host.memory.usedBytes': null,
      'host.memory.swapUsedBytes': 10,
      'host.storage.rootFilesystemAvailableBytes': 50,
    },
    {
      memoryTotalBytes: 0,
      swapTotalBytes: -1,
      rootFilesystemTotalBytes: 0,
    }
  )
  // `memoryUsedBytes` is a stored passthrough in v5, so a null reading stays
  // null regardless of the capacity — it is no longer reconstructed from it.
  assertEquals(zeroTotal.memoryUsedBytes, null)
  assertEquals(zeroTotal.memoryUsedPercent, null)
  assertEquals(zeroTotal.swapUsedPercent, null)
  assertEquals(zeroTotal.rootFilesystemUsedBytes, -50)
  assertEquals(zeroTotal.rootFilesystemUsedPercent, null)
})

/** Cumulative-`le` bucket counts for a 200-request window, all at or under 100ms. */
function fastBuckets() {
  return {
    bucket10ms: 0,
    bucket50ms: 100,
    bucket100ms: 200,
    bucket500ms: 200,
    bucket1s: 200,
    bucket5s: 200,
  }
}

test('computeIngressDerivedValues computes error rate and latency, else null', () => {
  assertEquals(
    computeIngressDerivedValues({
      requests: 200,
      responses4xx: 10,
      responses5xx: 30,
      // A raw per-interval *sum*, divided by requests here rather than stored
      // pre-divided: 2.4s across 200 requests is a 12ms mean.
      requestDurationSecondsSum: 2.4,
    }),
    {
      errorRatePercent: 20,
      averageLatencyMs: 12,
      p50LatencyMs: null,
      p90LatencyMs: null,
      p99LatencyMs: null,
    }
  )

  assertEquals(computeIngressDerivedValues({}), {
    errorRatePercent: null,
    averageLatencyMs: null,
    p50LatencyMs: null,
    p90LatencyMs: null,
    p99LatencyMs: null,
  })
  // A zero-request window has no mean to report — the duration sum alone
  // cannot be turned into a per-request figure.
  assertEquals(
    computeIngressDerivedValues({
      requests: 0,
      responses4xx: 1,
      responses5xx: 1,
      requestDurationSecondsSum: 0.5,
    }),
    {
      errorRatePercent: null,
      averageLatencyMs: null,
      p50LatencyMs: null,
      p90LatencyMs: null,
      p99LatencyMs: null,
    }
  )
  assertEquals(
    computeIngressDerivedValues({
      requests: 10,
      responses4xx: null,
      responses5xx: 1,
    }),
    {
      errorRatePercent: null,
      averageLatencyMs: null,
      p50LatencyMs: null,
      p90LatencyMs: null,
      p99LatencyMs: null,
    }
  )
})

test('computeIngressDerivedValues interpolates percentiles within the bucket the rank falls in', () => {
  const derived = computeIngressDerivedValues({ requests: 200, ...fastBuckets() })
  // p50 rank = 100, exactly the 50ms cumulative edge — no interpolation past it.
  assertEquals(derived.p50LatencyMs, 50)
  // p90 rank = 180: 80 of the 100-wide (50ms..100ms) bucket, so 50 + 0.8*50.
  assertEquals(derived.p90LatencyMs, 90)
  // p99 rank = 198: 98 of that same bucket.
  assertEquals(derived.p99LatencyMs, 99)
})

test('computeIngressDerivedValues clamps a rank beyond the last finite bucket to that bound', () => {
  // Only half the window's requests landed in any measured bucket — the rest
  // are in the implicit `+Inf` bucket, which has no upper bound to
  // extrapolate toward.
  const derived = computeIngressDerivedValues({
    requests: 200,
    bucket10ms: 0,
    bucket50ms: 0,
    bucket100ms: 0,
    bucket500ms: 0,
    bucket1s: 0,
    bucket5s: 100,
  })
  assertEquals(derived.p50LatencyMs, 5000)
  assertEquals(derived.p99LatencyMs, 5000)
})

test('computeIngressDerivedValues clamps non-monotonic bucket counts before interpolating', () => {
  // Each bucket is an independent `delta-sum` series, so counter-reset
  // clipping can leave a higher bound with a smaller window total. Without
  // the monotone clamp this would compute a negative bucket population.
  const derived = computeIngressDerivedValues({
    requests: 100,
    bucket10ms: 0,
    bucket50ms: 80,
    bucket100ms: 60,
    bucket500ms: 100,
    bucket1s: 100,
    bucket5s: 100,
  })
  assertEquals(derived.p50LatencyMs, 10 + (50 / 80) * 40)
  assertEquals(derived.p90LatencyMs, 100 + (10 / 20) * 400)
})

test('computeIngressDerivedValues returns null percentiles when any bucket is missing', () => {
  const derived = computeIngressDerivedValues({
    requests: 200,
    bucket10ms: 0,
    bucket50ms: 100,
    bucket100ms: null,
    bucket500ms: 200,
    bucket1s: 200,
    bucket5s: 200,
  })
  assertEquals(derived.p50LatencyMs, null)
  assertEquals(derived.p90LatencyMs, null)
  assertEquals(derived.p99LatencyMs, null)
})
