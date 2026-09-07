import { assertEquals, assertThrows } from '@std/assert'
import type {
  BlockDeviceSampleV5,
  CpuDetailSampleV5,
  DatabaseProxySampleV5,
  FilesystemSampleV5,
  GpuSampleV5,
  HardwareSignalSampleV5,
  HostCpuMetricsV5,
  HostKernelMetricsV5,
  HostMemoryMetricsV5,
  HostNetworkMetricsV5,
  HostStorageMetricsV5,
  IngressSourceSampleV5,
  MemoryDetailSampleV5,
  NetworkDeviceSampleV5,
} from './contract-v5.ts'
import {
  _internalV5,
  HOST_METRICS_METRIC_DESCRIPTORS_V5,
  type HostedFamilyV5,
  type HostMetricsMetricDescriptorV5,
  sanitizeMetricValueV5,
} from './metric-descriptors-v5.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// ---------------------------------------------------------------------------
// Descriptor <-> contract field agreement
// ---------------------------------------------------------------------------

type EntityFieldSpec = { entityScope: string; fields: string[] }

const ENTITY_FIELD_SPECS: EntityFieldSpec[] = [
  {
    entityScope: 'host.cpu',
    fields: [
      'busyPercent',
      'userPercent',
      'systemPercent',
      'iowaitPercent',
      'stealPercent',
      'softirqPercent',
      'pressureSomePercent',
      'saturatedCoreCount',
      'procsRunning',
      'procsBlocked',
      'processCount',
    ] satisfies (keyof HostCpuMetricsV5)[],
  },
  {
    entityScope: 'host.kernel',
    fields: [
      'fileHandlesUsedPercent',
      'conntrackUsedPercent',
    ] satisfies (keyof HostKernelMetricsV5)[],
  },
  {
    entityScope: 'host.memory',
    fields: [
      'usedBytes',
      'cachedFilesBytes',
      'swapUsedBytes',
      'pressureSomePercent',
      'pressureFullPercent',
      'swapInBytesPerSecond',
      'swapOutBytesPerSecond',
      'majorPageFaultsPerSecond',
    ] satisfies (keyof HostMemoryMetricsV5)[],
  },
  {
    entityScope: 'host.storage',
    fields: [
      'ioPressureSomePercent',
      'ioPressureFullPercent',
      'diskReadBytesPerSecond',
      'diskWriteBytesPerSecond',
      'diskLatencyMs',
      'rootFilesystemAvailableBytes',
      'rootFilesystemFreeInodes',
    ] satisfies (keyof HostStorageMetricsV5)[],
  },
  {
    entityScope: 'host.network',
    fields: [
      'tcpRetransmitPercent',
      'softnetDropsPerSecond',
    ] satisfies (keyof HostNetworkMetricsV5)[],
  },
  {
    entityScope: 'network',
    fields: [
      'receiveBytesPerSecond',
      'transmitBytesPerSecond',
      'receiveErrorsPerSecond',
      'transmitErrorsPerSecond',
      'receiveDropsPerSecond',
      'transmitDropsPerSecond',
    ] satisfies Exclude<keyof NetworkDeviceSampleV5, 'deviceId'>[],
  },
  {
    entityScope: 'filesystem',
    fields: ['availableBytes', 'freeInodes'] satisfies Exclude<
      keyof FilesystemSampleV5,
      'filesystemId'
    >[],
  },
  {
    entityScope: 'block',
    fields: [
      'readBytesPerSecond',
      'writeBytesPerSecond',
      'readOpsPerSecond',
      'writeOpsPerSecond',
      'readLatencyMs',
      'writeLatencyMs',
      'utilizationPercent',
      'temperatureCelsius',
      'queueDepth',
    ] satisfies Exclude<keyof BlockDeviceSampleV5, 'deviceId'>[],
  },
  {
    entityScope: 'gpu',
    fields: [
      'utilizationPercent',
      'memoryUsedBytes',
      'memoryActivityPercent',
      'temperatureCelsius',
      'memoryTemperatureCelsius',
      'powerWatts',
      'pcieReceiveBytesPerSecond',
      'pcieTransmitBytesPerSecond',
      'throttlePercent',
    ] satisfies Exclude<keyof GpuSampleV5, 'gpuId'>[],
  },
  {
    entityScope: 'hardwareSignal',
    fields: ['value'] satisfies Exclude<keyof HardwareSignalSampleV5, 'signalId' | 'kind'>[],
  },
  {
    entityScope: 'ingress',
    fields: [
      'requests',
      'responses2xx',
      'responses3xx',
      'responses4xx',
      'responses5xx',
      'requestErrors',
      'requestBytes',
      'responseBytes',
      'requestDurationSecondsAvg',
      'requestsUnder100ms',
      'requestsUnder500ms',
      'requestsUnder1s',
      'requestsUnder5s',
      'requestsInFlight',
      'upstreamsHealthy',
      'upstreamsTotal',
      'retries',
    ] satisfies Exclude<keyof IngressSourceSampleV5, 'sourceId' | 'sourceKind'>[],
  },
  {
    entityScope: 'databaseProxy',
    fields: [
      'queries',
      'slowQueries',
      'connectionErrors',
      'clientConnections',
      'backendConnections',
      'backendsUp',
    ] satisfies Exclude<keyof DatabaseProxySampleV5, 'sourceId' | 'sourceKind'>[],
  },
  {
    entityScope: 'cpuDetail',
    fields: [
      'averageFrequencyMHz',
      'minimumFrequencyMHz',
      'maximumFrequencyMHz',
      'contextSwitchesPerSecond',
      'interruptsPerSecond',
      'forksPerSecond',
      'cpuIrqPercent',
    ] satisfies (keyof CpuDetailSampleV5)[],
  },
  {
    entityScope: 'memoryDetail',
    fields: [
      'memoryFreeBytes',
      'cachedBytes',
      'anonPagesBytes',
      'slabReclaimableBytes',
      'slabUnreclaimableBytes',
      'dirtyBytes',
      'writebackBytes',
      'shmemBytes',
      'pageTablesBytes',
      'kernelStackBytes',
      'committedAsBytes',
      'commitLimitBytes',
      'activeAnonBytes',
      'inactiveAnonBytes',
      'activeFileBytes',
      'inactiveFileBytes',
      'pageScanDirectPerSecond',
      'pageScanKswapdPerSecond',
      'compactionStallsPerSecond',
    ] satisfies (keyof MemoryDetailSampleV5)[],
  },
]

test('every contract field (host sub-object or per-entity) has exactly one matching descriptor, qualified by entity scope', () => {
  for (const spec of ENTITY_FIELD_SPECS) {
    for (const field of spec.fields) {
      const canonicalName = `${spec.entityScope}.${field}`
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[canonicalName]
      assertEquals(descriptor?.fieldName, field, `missing descriptor for ${canonicalName}`)
      assertEquals(descriptor.entityScope, spec.entityScope)
    }
  }
})

test('no orphan descriptors reference a field outside the known contract shape', () => {
  const knownCanonicalNames = new Set<string>(
    ENTITY_FIELD_SPECS.flatMap((spec) => spec.fields.map((field) => `${spec.entityScope}.${field}`))
  )
  for (const canonicalName of Object.keys(HOST_METRICS_METRIC_DESCRIPTORS_V5)) {
    assertEquals(
      knownCanonicalNames.has(canonicalName),
      true,
      `descriptor ${canonicalName} does not correspond to a known contract field`
    )
  }
})

test('descriptor map keys always equal their own canonicalName', () => {
  for (const [key, descriptor] of Object.entries(HOST_METRICS_METRIC_DESCRIPTORS_V5)) {
    assertEquals(descriptor.canonicalName, key)
  }
})

// ---------------------------------------------------------------------------
// Family / per-entity capacity assertions
// ---------------------------------------------------------------------------

test('fixed-shape hostedFamily descriptor counts stay within their AE page budget', () => {
  for (const [family, cap] of Object.entries(_internalV5.HOSTED_FAMILY_CAPACITY_V5)) {
    const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V5).filter(
      (d) => d.hostedFamily === family
    ).length
    assertEquals(count > 0, true, `hostedFamily ${family} has no descriptors`)
    assertEquals(
      count <= (cap as number),
      true,
      `hostedFamily ${family} has ${count} descriptors, exceeding ${cap}`
    )
  }
})

test('per-entity-packed hostedFamily descriptor counts stay within their per-entity slot budget', () => {
  for (const [family, cap] of Object.entries(_internalV5.PER_ENTITY_CAPACITY_V5)) {
    const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V5).filter(
      (d) => d.hostedFamily === family
    ).length
    assertEquals(count > 0, true, `hostedFamily ${family} has no descriptors`)
    assertEquals(
      count <= (cap as number),
      true,
      `hostedFamily ${family} has ${count} descriptors, exceeding ${cap}`
    )
  }
})

test('assertHostedFamilyCapacity throws when a fixed-shape family is intentionally oversized', () => {
  const oversized: Record<string, HostMetricsMetricDescriptorV5> = {
    ...HOST_METRICS_METRIC_DESCRIPTORS_V5,
  }
  for (let i = 0; i < 20; i++) {
    const canonicalName = `host.system.synthetic${i}`
    oversized[canonicalName] = {
      canonicalName,
      fieldName: `synthetic${i}`,
      unit: 'count',
      semantic: 'gauge',
      aggregation: 'weighted-average',
      entityScope: 'host.cpu',
      hostedFamily: 'host.system' as HostedFamilyV5,
      resetBehavior: 'none',
      availabilityBehavior: 'legitimate-zero',
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      sanitize: 'null',
    }
  }
  assertThrows(
    () => _internalV5.assertHostedFamilyCapacity(oversized),
    TypeError,
    'hostedFamily "host.system" has'
  )
})

test('assertHostedFamilyCapacity throws when a per-entity-packed family is intentionally oversized', () => {
  const oversized: Record<string, HostMetricsMetricDescriptorV5> = {
    ...HOST_METRICS_METRIC_DESCRIPTORS_V5,
  }
  for (let i = 0; i < 10; i++) {
    const canonicalName = `gpu.synthetic${i}`
    oversized[canonicalName] = {
      canonicalName,
      fieldName: `synthetic${i}`,
      unit: 'count',
      semantic: 'gauge',
      aggregation: 'weighted-average',
      entityScope: 'gpu',
      hostedFamily: 'gpu',
      resetBehavior: 'none',
      availabilityBehavior: 'legitimate-zero',
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      sanitize: 'null',
    }
  }
  assertThrows(
    () => _internalV5.assertHostedFamilyCapacity(oversized),
    TypeError,
    'hostedFamily "gpu" has'
  )
})

test('buildDescriptorMap throws on a canonicalName collision instead of silently overwriting', () => {
  const duplicate: HostMetricsMetricDescriptorV5 = {
    canonicalName: 'gpu.utilizationPercent',
    fieldName: 'utilizationPercent',
    unit: 'percent',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'gpu',
    hostedFamily: 'gpu',
    resetBehavior: 'none',
    availabilityBehavior: 'missing-when-unsupported',
    min: 0,
    max: 100,
    sanitize: 'clamp',
  }
  assertThrows(
    () =>
      _internalV5.buildDescriptorMap([
        { 'gpu.utilizationPercent': duplicate },
        { 'gpu.utilizationPercent': duplicate },
      ]),
    TypeError,
    'duplicate metric canonicalName: gpu.utilizationPercent'
  )
})

// ---------------------------------------------------------------------------
// sanitizeMetricValueV5 clamp/sanitize behavior
// ---------------------------------------------------------------------------

test('sanitizeMetricValueV5 clamps a percent (clamp) descriptor out of range', () => {
  assertEquals(sanitizeMetricValueV5('host.cpu.busyPercent', 150), 100)
  assertEquals(sanitizeMetricValueV5('host.cpu.busyPercent', -10), 0)
  assertEquals(sanitizeMetricValueV5('host.cpu.busyPercent', 42), 42)
})

test('sanitizeMetricValueV5 nulls a non-negative (null) descriptor out of range', () => {
  assertEquals(sanitizeMetricValueV5('network.receiveBytesPerSecond', -1), null)
  assertEquals(sanitizeMetricValueV5('network.receiveBytesPerSecond', 500), 500)
})

test('sanitizeMetricValueV5 passes null through untouched', () => {
  assertEquals(sanitizeMetricValueV5('gpu.temperatureCelsius', null), null)
})

test('sanitizeMetricValueV5 rejects non-finite values', () => {
  assertEquals(sanitizeMetricValueV5('gpu.temperatureCelsius', Number.NaN), null)
  assertEquals(sanitizeMetricValueV5('gpu.temperatureCelsius', Number.POSITIVE_INFINITY), null)
})

test('sanitizeMetricValueV5 throws on an unknown canonicalName', () => {
  assertThrows(
    () => sanitizeMetricValueV5('not.a.real.metric', 1),
    TypeError,
    'unknown v5 metric canonicalName: not.a.real.metric'
  )
})

test('sanitizeMetricValueV5 bounds a temperature (null, negative-allowed) descriptor', () => {
  assertEquals(sanitizeMetricValueV5('block.temperatureCelsius', -50), -50)
  assertEquals(sanitizeMetricValueV5('block.temperatureCelsius', -150), null)
  assertEquals(sanitizeMetricValueV5('block.temperatureCelsius', 250), null)
})
