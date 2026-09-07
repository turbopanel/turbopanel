import { assertEquals, assertThrows } from '@std/assert'
import {
  buildMetricsSampleV5,
  clampPercent,
  METRIC_EVENT_KINDS_V5,
  type MetricEventV5,
  METRICS_SCHEMA_VERSION_V5,
  type MetricsSampleV5Input,
  sanitizeFinite,
} from './contract-v5.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('METRICS_SCHEMA_VERSION_V5 is 5', () => {
  assertEquals(METRICS_SCHEMA_VERSION_V5, 5)
})

test('METRIC_EVENT_KINDS_V5 has no duplicates', () => {
  assertEquals(new Set(METRIC_EVENT_KINDS_V5).size, METRIC_EVENT_KINDS_V5.length)
})

test('clampPercent clamps 0-100 and passes null', () => {
  assertEquals(clampPercent(null), null)
  assertEquals(clampPercent(0), 0)
  assertEquals(clampPercent(100), 100)
  assertEquals(clampPercent(50.5), 50.5)
  assertEquals(clampPercent(-1), 0)
  assertEquals(clampPercent(101), 100)
})

test('sanitizeFinite rejects NaN and +/-Infinity, keeps missing as null', () => {
  assertEquals(sanitizeFinite(null), null)
  assertEquals(sanitizeFinite(undefined), null)
  assertEquals(sanitizeFinite(42), 42)
  assertEquals(sanitizeFinite(Number.NaN), null)
  assertEquals(sanitizeFinite(Number.POSITIVE_INFINITY), null)
  assertEquals(sanitizeFinite(Number.NEGATIVE_INFINITY), null)
})

/**
 * Shared fixture, hand-mirrored into `contract-v5.test.ts` in
 * `turbopaneld/src/metrics`. Both files exercise `buildMetricsSampleV5`
 * against this same hard-coded expected-shape input/output pair as a
 * behavioral check — it is not itself the drift gate. Real mirror-drift
 * detection is the parity suite at the bottom of this file, which reads the
 * counterpart `contract-v5.ts` off the co-located sibling checkout and
 * diffs it directly, rather than trusting two hand-copied fixtures to stay
 * in sync by discipline alone.
 */
function fixtureInput(): MetricsSampleV5Input {
  return {
    metadata: {
      version: METRICS_SCHEMA_VERSION_V5,
      sampledAt: '2020-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      collectionMode: 'baseline',
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: 42.5,
        userPercent: 20,
        systemPercent: 10,
        iowaitPercent: 1,
        stealPercent: 0,
        softirqPercent: 0.5,
        pressureSomePercent: 150,
        saturatedCoreCount: 2,
        procsRunning: 3,
        procsBlocked: 0,
        processCount: 42,
      },
      kernel: {
        fileHandlesUsedPercent: 12,
        conntrackUsedPercent: Number.NaN,
      },
      memory: {
        usedBytes: 1_000_000,
        cachedFilesBytes: 250_000,
        swapUsedBytes: 0,
        pressureSomePercent: 5,
        pressureFullPercent: 0,
        swapInBytesPerSecond: undefined,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: 2,
      },
      storage: {
        ioPressureSomePercent: 3,
        ioPressureFullPercent: 0,
        diskReadBytesPerSecond: 500,
        diskWriteBytesPerSecond: 250,
        diskLatencyMs: 1.8,
        rootFilesystemAvailableBytes: 2_000_000,
        rootFilesystemFreeInodes: 10_000,
      },
      network: {
        tcpRetransmitPercent: 0.1,
        softnetDropsPerSecond: 0,
      },
    },
    networks: [
      {
        deviceId: 'eth0',
        receiveBytesPerSecond: 100,
        transmitBytesPerSecond: 200,
        receiveErrorsPerSecond: 0,
        transmitErrorsPerSecond: 0,
        receiveDropsPerSecond: 0,
        transmitDropsPerSecond: 0,
      },
    ],
    filesystems: [
      {
        filesystemId: '/srv',
        availableBytes: 5_000_000,
        freeInodes: 1_000,
      },
    ],
    blockDevices: [
      {
        deviceId: 'sda',
        readBytesPerSecond: 10,
        writeBytesPerSecond: 20,
        readOpsPerSecond: 1,
        writeOpsPerSecond: 2,
        readLatencyMs: 0.5,
        writeLatencyMs: 0.6,
        utilizationPercent: 150,
        temperatureCelsius: 45,
        queueDepth: 1,
      },
    ],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [
      {
        eventId: 'evt-1',
        at: '2020-01-01T00:00:00.000Z',
        kind: 'smart_critical',
        severity: 'critical',
      } satisfies MetricEventV5,
    ],
  }
}

test('buildMetricsSampleV5 sanitizes the shared cross-repo fixture', () => {
  const sample = buildMetricsSampleV5(fixtureInput())

  assertEquals(sample.type, 'metrics')
  assertEquals(sample.metadata.version, 5)
  assertEquals(sample.host.cpu.pressureSomePercent, 100)
  assertEquals(sample.host.cpu.processCount, 42)
  assertEquals(sample.host.kernel.conntrackUsedPercent, null)
  assertEquals(sample.host.memory.swapInBytesPerSecond, null)
  assertEquals(sample.host.memory.swapOutBytesPerSecond, null)
  assertEquals(sample.blockDevices[0].utilizationPercent, 100)
  assertEquals(sample.networks[0].deviceId, 'eth0')
  assertEquals(sample.events[0].kind, 'smart_critical')
})

test('buildMetricsSampleV5 never coerces missing metrics to 0', () => {
  const input = fixtureInput()
  input.host.storage.diskReadBytesPerSecond = undefined
  const sample = buildMetricsSampleV5(input)
  assertEquals(sample.host.storage.diskReadBytesPerSecond, null)
})

test('buildMetricsSampleV5 rejects a metadata.version that does not match METRICS_SCHEMA_VERSION_V5', () => {
  const input = fixtureInput()
  // deno-lint-ignore no-explicit-any
  input.metadata.version = 3 as any
  assertThrows(
    () => buildMetricsSampleV5(input),
    TypeError,
    `metrics metadata.version must be ${METRICS_SCHEMA_VERSION_V5}`
  )
})

test('buildMetricsSampleV5 rejects an invalid collectionMode', () => {
  const input = fixtureInput()
  // deno-lint-ignore no-explicit-any
  input.metadata.collectionMode = 'turbo' as any
  assertThrows(
    () => buildMetricsSampleV5(input),
    TypeError,
    'metrics metadata.collectionMode must be "baseline" or "live"'
  )
})

test('buildMetricsSampleV5 rejects non-positive intervalSeconds', () => {
  for (const intervalSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const input = fixtureInput()
    input.metadata.intervalSeconds = intervalSeconds
    assertThrows(
      () => buildMetricsSampleV5(input),
      TypeError,
      'metrics metadata.intervalSeconds must be a finite positive number'
    )
  }
})

test('buildMetricsSampleV5 rejects negative sequence/topologyGeneration/bootGeneration', () => {
  const sequenceInput = fixtureInput()
  sequenceInput.metadata.sequence = -1
  assertThrows(
    () => buildMetricsSampleV5(sequenceInput),
    TypeError,
    'metrics metadata.sequence must be a finite non-negative number'
  )

  const topologyInput = fixtureInput()
  topologyInput.metadata.topologyGeneration = -1
  assertThrows(
    () => buildMetricsSampleV5(topologyInput),
    TypeError,
    'metrics metadata.topologyGeneration must be a finite non-negative number'
  )

  const bootInput = fixtureInput()
  bootInput.metadata.bootGeneration = -1
  assertThrows(
    () => buildMetricsSampleV5(bootInput),
    TypeError,
    'metrics metadata.bootGeneration must be a finite non-negative number'
  )
})

test('buildMetricsSampleV5 accepts a zero sequence/topologyGeneration/bootGeneration', () => {
  const input = fixtureInput()
  input.metadata.sequence = 0
  input.metadata.topologyGeneration = 0
  input.metadata.bootGeneration = 0
  const sample = buildMetricsSampleV5(input)
  assertEquals(sample.metadata.sequence, 0)
  assertEquals(sample.metadata.topologyGeneration, 0)
  assertEquals(sample.metadata.bootGeneration, 0)
})

test('buildMetricsSampleV5 rejects an unknown event kind', () => {
  const input = fixtureInput()
  input.events = [
    {
      eventId: 'evt-bad',
      at: '2020-01-01T00:00:00.000Z',
      // deno-lint-ignore no-explicit-any
      kind: 'not_a_real_kind' as any,
      severity: 'info',
    },
  ]
  assertThrows(
    () => buildMetricsSampleV5(input),
    TypeError,
    'metrics event has an unknown kind: not_a_real_kind'
  )
})

test('buildMetricsSampleV5 rejects an invalid event severity', () => {
  const input = fixtureInput()
  input.events = [
    {
      eventId: 'evt-bad',
      at: '2020-01-01T00:00:00.000Z',
      kind: 'smart_critical',
      // deno-lint-ignore no-explicit-any
      severity: 'urgent' as any,
    },
  ]
  assertThrows(
    () => buildMetricsSampleV5(input),
    TypeError,
    'metrics event evt-bad has an invalid severity: urgent'
  )
})

test('buildMetricsSampleV5 rejects an entity array beyond the defensive cap', () => {
  const input = fixtureInput()
  input.networks = Array.from({ length: 65 }, (_, i) => ({
    deviceId: `eth${i}`,
    receiveBytesPerSecond: 0,
    transmitBytesPerSecond: 0,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }))
  assertThrows(
    () => buildMetricsSampleV5(input),
    TypeError,
    'metrics networks has 65 entries, exceeding the 64-entry cap'
  )
})

test('buildMetricsSampleV5 sanitizes all 19 memoryDetail fields, never coercing missing to 0', () => {
  const input = fixtureInput()
  input.memoryDetail = {
    memoryFreeBytes: 1,
    cachedBytes: 2,
    anonPagesBytes: 3,
    slabReclaimableBytes: 4,
    slabUnreclaimableBytes: 5,
    dirtyBytes: 6,
    writebackBytes: 7,
    shmemBytes: 8,
    pageTablesBytes: 9,
    kernelStackBytes: 10,
    committedAsBytes: 11,
    commitLimitBytes: 12,
    activeAnonBytes: 13,
    inactiveAnonBytes: 14,
    activeFileBytes: 15,
    inactiveFileBytes: 16,
    pageScanDirectPerSecond: undefined,
    pageScanKswapdPerSecond: 18,
    compactionStallsPerSecond: 19,
  }
  const sample = buildMetricsSampleV5(input)
  assertEquals(sample.memoryDetail?.memoryFreeBytes, 1)
  assertEquals(sample.memoryDetail?.inactiveFileBytes, 16)
  assertEquals(sample.memoryDetail?.pageScanDirectPerSecond, null)
  assertEquals(sample.memoryDetail?.pageScanKswapdPerSecond, 18)
  assertEquals(sample.memoryDetail?.compactionStallsPerSecond, 19)
})

// ---------------------------------------------------------------------------
// Mirrored-contract parity — the actual drift gate between this file and its
// twin in `turbopaneld/src/metrics`. Deno tests in two repos cannot import
// each other directly, so this reads the counterpart off the co-located
// sibling checkout instead (`../turbopaneld/...`, the same sibling-checkout
// layout `turbopaneld/scripts/check-metrics-legacy.ts` scans) and compares
// the mirrored surface area directly: schema version, event-kind catalog,
// export set, and the file body itself. When the sibling repo isn't checked
// out next to this one, the checks are skipped rather than failed (matching
// `check-metrics-legacy.ts`'s absent-sibling handling) — this repo's own
// suite still runs. No CI job currently checks out both repos and runs
// tests (`metrics-legacy` checks out both but only runs the legacy-string
// guard, not this suite), so today these checks are exercised in the
// co-located dev workspace, not CI; wiring a dual-checkout CI job is a
// follow-up, not part of this change.
// ---------------------------------------------------------------------------

const SIBLING_CONTRACT_V5_URL = new URL(
  '../../../../turbopaneld/src/metrics/contract-v5.ts',
  import.meta.url
)

const siblingContractV5Exists = await Deno.stat(SIBLING_CONTRACT_V5_URL)
  .then((stat) => stat.isFile)
  .catch(() => false)

/** Strips a file's own header docblock so only the shared contract body remains. */
function stripHeaderDocblock(source: string): string {
  const end = source.indexOf('*/')
  return end === -1 ? source : source.slice(end + 2)
}

test({
  name: 'contract-v5.ts stays byte-identical to its turbopaneld mirror below the header docblock',
  ignore: !siblingContractV5Exists,
  fn: async () => {
    const [ownSource, siblingSource] = await Promise.all([
      Deno.readTextFile(new URL('./contract-v5.ts', import.meta.url)),
      Deno.readTextFile(SIBLING_CONTRACT_V5_URL),
    ])
    assertEquals(stripHeaderDocblock(ownSource), stripHeaderDocblock(siblingSource))
  },
})

test({
  name: 'contract-v5.ts agrees with its turbopaneld mirror on schema version, event kinds, and export set',
  ignore: !siblingContractV5Exists,
  fn: async () => {
    const [own, sibling] = await Promise.all([
      import('./contract-v5.ts'),
      import(SIBLING_CONTRACT_V5_URL.href),
    ])
    assertEquals(sibling.METRICS_SCHEMA_VERSION_V5, own.METRICS_SCHEMA_VERSION_V5)
    assertEquals(sibling.METRIC_EVENT_KINDS_V5, own.METRIC_EVENT_KINDS_V5)
    assertEquals(new Set(Object.keys(sibling)), new Set(Object.keys(own)))
  },
})
