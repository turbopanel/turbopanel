import { assertEquals, assertThrows } from '@std/assert'
import type {
  BlockDeviceSampleV4,
  CpuCoreLiveSampleV4,
  CpuDetailSampleV4,
  CpuHotspotSampleV4,
  DatabaseProxySampleV4,
  FilesystemSampleV4,
  GpuSampleV4,
  HardwareSignalSampleV4,
  HostCpuMetricsV4,
  HostKernelMetricsV4,
  HostMemoryMetricsV4,
  HostNetworkMetricsV4,
  HostStorageMetricsV4,
  IngressSourceSampleV4,
  MemoryDetailSampleV4,
  NetworkDeviceSampleV4,
} from './contract-v4.ts'
import {
  _internalV4,
  HOST_METRICS_METRIC_DESCRIPTORS_V4,
  type HostedFamilyV4,
  type HostMetricsMetricDescriptorV4,
  sanitizeMetricValueV4,
} from './metric-descriptors-v4.ts'

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
      'maxCoreBusyPercent',
      'procsRunning',
      'procsBlocked',
      'processCount',
    ] satisfies (keyof HostCpuMetricsV4)[],
  },
  {
    entityScope: 'host.kernel',
    fields: [
      'fileHandlesUsedPercent',
      'conntrackUsedPercent',
    ] satisfies (keyof HostKernelMetricsV4)[],
  },
  {
    entityScope: 'host.memory',
    fields: [
      'availableBytes',
      'swapUsedBytes',
      'pressureSomePercent',
      'pressureFullPercent',
      'swapInBytesPerSecond',
      'swapOutBytesPerSecond',
      'majorPageFaultsPerSecond',
    ] satisfies (keyof HostMemoryMetricsV4)[],
  },
  {
    entityScope: 'host.storage',
    fields: [
      'ioPressureSomePercent',
      'ioPressureFullPercent',
      'diskReadBytesPerSecond',
      'diskWriteBytesPerSecond',
      'diskReadLatencyMs',
      'diskWriteLatencyMs',
      'maxBlockDeviceUtilPercent',
      'rootFilesystemAvailableBytes',
      'rootFilesystemFreeInodes',
    ] satisfies (keyof HostStorageMetricsV4)[],
  },
  {
    entityScope: 'host.network',
    fields: [
      'tcpRetransmitPercent',
      'softnetDropsPerSecond',
    ] satisfies (keyof HostNetworkMetricsV4)[],
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
    ] satisfies Exclude<keyof NetworkDeviceSampleV4, 'deviceId'>[],
  },
  {
    entityScope: 'filesystem',
    fields: ['availableBytes', 'freeInodes'] satisfies Exclude<
      keyof FilesystemSampleV4,
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
    ] satisfies Exclude<keyof BlockDeviceSampleV4, 'deviceId'>[],
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
    ] satisfies Exclude<keyof GpuSampleV4, 'gpuId'>[],
  },
  {
    entityScope: 'hardwareSignal',
    fields: ['value'] satisfies Exclude<keyof HardwareSignalSampleV4, 'signalId' | 'kind'>[],
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
    ] satisfies Exclude<keyof IngressSourceSampleV4, 'sourceId' | 'sourceKind'>[],
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
    ] satisfies Exclude<keyof DatabaseProxySampleV4, 'sourceId' | 'sourceKind'>[],
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
    ] satisfies Exclude<keyof CpuDetailSampleV4, 'hotspots'>[],
  },
  {
    entityScope: 'cpuHotspot',
    fields: ['busyPercent', 'iowaitPercent', 'stealPercent'] satisfies Exclude<
      keyof CpuHotspotSampleV4,
      'coreId'
    >[],
  },
  {
    entityScope: 'cpuCore',
    fields: ['busyPercent', 'iowaitPercent', 'stealPercent'] satisfies Exclude<
      keyof CpuCoreLiveSampleV4,
      'coreId'
    >[],
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
    ] satisfies (keyof MemoryDetailSampleV4)[],
  },
]

test('every contract field (host sub-object or per-entity) has exactly one matching descriptor, qualified by entity scope', () => {
  for (const spec of ENTITY_FIELD_SPECS) {
    for (const field of spec.fields) {
      const canonicalName = `${spec.entityScope}.${field}`
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V4[canonicalName]
      assertEquals(descriptor?.fieldName, field, `missing descriptor for ${canonicalName}`)
      assertEquals(descriptor.entityScope, spec.entityScope)
    }
  }
})

test('no orphan descriptors reference a field outside the known contract shape', () => {
  const knownCanonicalNames = new Set<string>(
    ENTITY_FIELD_SPECS.flatMap((spec) => spec.fields.map((field) => `${spec.entityScope}.${field}`))
  )
  for (const canonicalName of Object.keys(HOST_METRICS_METRIC_DESCRIPTORS_V4)) {
    assertEquals(
      knownCanonicalNames.has(canonicalName),
      true,
      `descriptor ${canonicalName} does not correspond to a known contract field`
    )
  }
})

test('descriptor map keys always equal their own canonicalName', () => {
  for (const [key, descriptor] of Object.entries(HOST_METRICS_METRIC_DESCRIPTORS_V4)) {
    assertEquals(descriptor.canonicalName, key)
  }
})

// ---------------------------------------------------------------------------
// Family / per-entity capacity assertions
// ---------------------------------------------------------------------------

test('fixed-shape hostedFamily descriptor counts stay within their AE page budget', () => {
  for (const [family, cap] of Object.entries(_internalV4.HOSTED_FAMILY_CAPACITY_V4)) {
    const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4).filter(
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
  for (const [family, cap] of Object.entries(_internalV4.PER_ENTITY_CAPACITY_V4)) {
    const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4).filter(
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

test("cpu.detail's 4 embedded hotspot slots plus 7 scalar fields exactly fill its 19-slot AE page budget", () => {
  const cpuDetailScalarCount = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4).filter(
    (d) => d.hostedFamily === 'cpu.detail' && d.entityScope === 'cpuDetail'
  ).length
  const cpuHotspotFieldCount = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4).filter(
    (d) => d.entityScope === 'cpuHotspot'
  ).length
  const hotspotMultiplier = _internalV4.EMBEDDED_SCOPE_MULTIPLIER_V4.cpuHotspot
  assertEquals(cpuDetailScalarCount, 7)
  assertEquals(cpuHotspotFieldCount, 3)
  assertEquals(hotspotMultiplier, 4)
  assertEquals(cpuDetailScalarCount + cpuHotspotFieldCount * (hotspotMultiplier as number), 19)
})

test('cpu.core.live per-entity descriptor count exactly fills its 3-slot per-entity budget', () => {
  const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V4).filter(
    (d) => d.hostedFamily === 'cpu.core.live'
  ).length
  assertEquals(count, 3)
  assertEquals(_internalV4.PER_ENTITY_CAPACITY_V4['cpu.core.live'], 3)
})

test('assertHostedFamilyCapacity throws when a fixed-shape family is intentionally oversized', () => {
  const oversized: Record<string, HostMetricsMetricDescriptorV4> = {
    ...HOST_METRICS_METRIC_DESCRIPTORS_V4,
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
      hostedFamily: 'host.system' as HostedFamilyV4,
      resetBehavior: 'none',
      availabilityBehavior: 'legitimate-zero',
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      sanitize: 'null',
    }
  }
  assertThrows(
    () => _internalV4.assertHostedFamilyCapacity(oversized),
    TypeError,
    'hostedFamily "host.system" has'
  )
})

test('assertHostedFamilyCapacity throws when a per-entity-packed family is intentionally oversized', () => {
  const oversized: Record<string, HostMetricsMetricDescriptorV4> = {
    ...HOST_METRICS_METRIC_DESCRIPTORS_V4,
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
    () => _internalV4.assertHostedFamilyCapacity(oversized),
    TypeError,
    'hostedFamily "gpu" has'
  )
})

test('buildDescriptorMap throws on a canonicalName collision instead of silently overwriting', () => {
  const duplicate: HostMetricsMetricDescriptorV4 = {
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
      _internalV4.buildDescriptorMap([
        { 'gpu.utilizationPercent': duplicate },
        { 'gpu.utilizationPercent': duplicate },
      ]),
    TypeError,
    'duplicate metric canonicalName: gpu.utilizationPercent'
  )
})

// ---------------------------------------------------------------------------
// sanitizeMetricValueV4 clamp/sanitize behavior
// ---------------------------------------------------------------------------

test('sanitizeMetricValueV4 clamps a percent (clamp) descriptor out of range', () => {
  assertEquals(sanitizeMetricValueV4('host.cpu.busyPercent', 150), 100)
  assertEquals(sanitizeMetricValueV4('host.cpu.busyPercent', -10), 0)
  assertEquals(sanitizeMetricValueV4('host.cpu.busyPercent', 42), 42)
})

test('sanitizeMetricValueV4 nulls a non-negative (null) descriptor out of range', () => {
  assertEquals(sanitizeMetricValueV4('network.receiveBytesPerSecond', -1), null)
  assertEquals(sanitizeMetricValueV4('network.receiveBytesPerSecond', 500), 500)
})

test('sanitizeMetricValueV4 passes null through untouched', () => {
  assertEquals(sanitizeMetricValueV4('gpu.temperatureCelsius', null), null)
})

test('sanitizeMetricValueV4 rejects non-finite values', () => {
  assertEquals(sanitizeMetricValueV4('gpu.temperatureCelsius', Number.NaN), null)
  assertEquals(sanitizeMetricValueV4('gpu.temperatureCelsius', Number.POSITIVE_INFINITY), null)
})

test('sanitizeMetricValueV4 throws on an unknown canonicalName', () => {
  assertThrows(
    () => sanitizeMetricValueV4('not.a.real.metric', 1),
    TypeError,
    'unknown v4 metric canonicalName: not.a.real.metric'
  )
})

test('sanitizeMetricValueV4 bounds a temperature (null, negative-allowed) descriptor', () => {
  assertEquals(sanitizeMetricValueV4('block.temperatureCelsius', -50), -50)
  assertEquals(sanitizeMetricValueV4('block.temperatureCelsius', -150), null)
  assertEquals(sanitizeMetricValueV4('block.temperatureCelsius', 250), null)
})
