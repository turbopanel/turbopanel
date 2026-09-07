import { assertEquals } from '@std/assert'
import {
  computeDerivedHostValuesV5,
  computeIngressDerivedValues,
  type HostCapacitiesV5,
} from './derived-metrics-v5.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const EMPTY_CAPACITIES: HostCapacitiesV5 = {
  memoryTotalBytes: null,
  swapTotalBytes: null,
  rootFilesystemTotalBytes: null,
}

test('computeDerivedHostValuesV5 passes cpu busy through and derives used percents', () => {
  const derived = computeDerivedHostValuesV5(
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

test('computeDerivedHostValuesV5 propagates nulls and rejects a non-positive total', () => {
  const missing = computeDerivedHostValuesV5({}, EMPTY_CAPACITIES)
  assertEquals(missing, {
    cpuUsagePercent: null,
    memoryUsedBytes: null,
    memoryUsedPercent: null,
    swapUsedPercent: null,
    rootFilesystemUsedBytes: null,
    rootFilesystemUsedPercent: null,
  })

  const zeroTotal = computeDerivedHostValuesV5(
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

test('computeIngressDerivedValues computes error rate and latency, else null', () => {
  assertEquals(
    computeIngressDerivedValues({
      requests: 200,
      responses4xx: 10,
      responses5xx: 30,
      requestDurationSecondsAvg: 0.012,
    }),
    { errorRatePercent: 20, averageLatencyMs: 12 }
  )

  assertEquals(computeIngressDerivedValues({}), {
    errorRatePercent: null,
    averageLatencyMs: null,
  })
  assertEquals(
    computeIngressDerivedValues({
      requests: 0,
      responses4xx: 1,
      responses5xx: 1,
      requestDurationSecondsAvg: 0.5,
    }),
    { errorRatePercent: null, averageLatencyMs: 500 }
  )
  assertEquals(
    computeIngressDerivedValues({
      requests: 10,
      responses4xx: null,
      responses5xx: 1,
    }),
    { errorRatePercent: null, averageLatencyMs: null }
  )
})
