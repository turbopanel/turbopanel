import { assertEquals, assertThrows } from '@std/assert'
import type {
  BlockDeviceSample,
  DatabaseProxySample,
  DiagnosticsCpuSample,
  DiagnosticsMemorySample,
  DockerUsageSample,
  FilesystemSample,
  GpuSample,
  HardwareSignalSample,
  HostCpuMetrics,
  HostKernelMetrics,
  HostMemoryMetrics,
  HostNetworkMetrics,
  HostStorageMetrics,
  IngressSourceSample,
  NetworkDeviceSample,
  RouterSample,
  StorageSample,
} from './contract.ts'
import {
  STORAGE_ENGINE_FIELD_NAMES,
  STORAGE_ENGINE_KEYS,
  STORAGE_FLAT_FIELD_NAMES,
  storageEngineFieldName,
} from './contract.ts'
import {
  _internal,
  HOST_METRICS_METRIC_DESCRIPTORS,
  type HostedFamily,
  type HostMetricsMetricDescriptor,
  sanitizeMetricValue,
} from './metric-descriptors.ts'

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
    ] satisfies (keyof HostCpuMetrics)[],
  },
  {
    entityScope: 'host.kernel',
    fields: [
      'fileHandlesUsedPercent',
      'conntrackUsedPercent',
    ] satisfies (keyof HostKernelMetrics)[],
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
    ] satisfies (keyof HostMemoryMetrics)[],
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
    ] satisfies (keyof HostStorageMetrics)[],
  },
  {
    entityScope: 'host.network',
    fields: [
      'tcpRetransmitPercent',
      'softnetDropsPerSecond',
    ] satisfies (keyof HostNetworkMetrics)[],
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
    ] satisfies Exclude<keyof NetworkDeviceSample, 'deviceId'>[],
  },
  {
    entityScope: 'filesystem',
    fields: ['availableBytes', 'freeInodes'] satisfies Exclude<
      keyof FilesystemSample,
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
      'queueDepth',
    ] satisfies Exclude<keyof BlockDeviceSample, 'deviceId'>[],
  },
  {
    entityScope: 'gpu',
    fields: [
      'utilizationPercent',
      'memoryUsedBytes',
      'memoryActivityPercent',
      'pcieReceiveBytesPerSecond',
      'pcieTransmitBytesPerSecond',
      'throttlePercent',
    ] satisfies Exclude<keyof GpuSample, 'gpuId'>[],
  },
  {
    entityScope: 'hardwareSignal',
    fields: ['value'] satisfies Exclude<keyof HardwareSignalSample, 'signalId' | 'kind'>[],
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
      'requestDurationSecondsSum',
      'bucket10ms',
      'bucket50ms',
      'bucket100ms',
      'bucket500ms',
      'bucket1s',
      'bucket5s',
      'requestsInFlight',
      'upstreamsHealthy',
      'upstreamsTotal',
      'retries',
    ] satisfies Exclude<keyof IngressSourceSample, 'sourceId' | 'sourceKind'>[],
  },
  {
    entityScope: 'databaseProxy',
    fields: [
      'queries',
      'slowQueries',
      'queryLatencyMsAvg',
      'backendLatencyMsAvg',
      'activeTransactions',
      'clientConnections',
      'clientConnectionsCreated',
      'clientConnectionsAborted',
      'connectionsRejectedMaxConns',
      'backendConnections',
      'backendConnectionsCreated',
      'backendConnectionsAborted',
      'connectionErrors',
      'backendsUp',
      'backendsTotal',
      'bytesFromBackends',
      'bytesToBackends',
    ] satisfies Exclude<keyof DatabaseProxySample, 'sourceId' | 'sourceKind'>[],
  },
  {
    entityScope: 'router',
    fields: [
      'backendsUp',
      'backendsTotal',
      'servicesTotal',
      'routersTotal',
      'retries',
      'backendErrors5xx',
      'backendLatencyMsAvg',
      'backendRequests',
      'httpOpenConnections',
      'configReloads',
      'configLastReloadAgeSeconds',
      'tlsCertSoonestExpiryDays',
    ] satisfies (keyof RouterSample)[],
  },
  {
    entityScope: 'storage',
    // The seven flat `StorageSample` fields, then the twelve flattened
    // per-engine ones — the same `<engine><Field>` rule the descriptors use,
    // derived rather than restated so a typo cannot make both sides agree on
    // a wrong name.
    fields: [
      ...([...STORAGE_FLAT_FIELD_NAMES] satisfies Exclude<
        keyof StorageSample,
        'postgres' | 'mysql' | 'mariadb'
      >[]),
      ...STORAGE_ENGINE_KEYS.flatMap((engine) =>
        STORAGE_ENGINE_FIELD_NAMES.map((field) => storageEngineFieldName(engine, field))
      ),
    ],
  },
  {
    entityScope: 'dockerUsage',
    fields: [
      'layersBytes',
      'imagesCount',
      'imagesReclaimableBytes',
      'containersBytes',
      'containersCount',
      'volumesBytes',
      'volumesCount',
      'volumesReclaimableBytes',
      'buildCacheBytes',
      'buildCacheReclaimableBytes',
    ] satisfies (keyof DockerUsageSample)[],
  },
  {
    entityScope: 'diagnostics',
    fields: [
      'averageFrequencyMHz',
      'minimumFrequencyMHz',
      'maximumFrequencyMHz',
      'contextSwitchesPerSecond',
      'interruptsPerSecond',
      'forksPerSecond',
      'cpuIrqPercent',
    ] satisfies (keyof DiagnosticsCpuSample)[],
  },
  {
    entityScope: 'diagnostics',
    fields: [
      'memoryFreeBytes',
      'cachedBytes',
      'anonPagesBytes',
      'slabReclaimableBytes',
      'slabUnreclaimableBytes',
      'dirtyBytes',
      'writebackBytes',
      'shmemBytes',
      'committedAsBytes',
      'pageScanDirectPerSecond',
      'pageScanKswapdPerSecond',
      'compactionStallsPerSecond',
    ] satisfies (keyof DiagnosticsMemorySample)[],
  },
]

test('every contract field (host sub-object or per-entity) has exactly one matching descriptor, qualified by entity scope', () => {
  for (const spec of ENTITY_FIELD_SPECS) {
    for (const field of spec.fields) {
      const canonicalName = `${spec.entityScope}.${field}`
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[canonicalName]
      assertEquals(descriptor?.fieldName, field, `missing descriptor for ${canonicalName}`)
      assertEquals(descriptor.entityScope, spec.entityScope)
    }
  }
})

test('no orphan descriptors reference a field outside the known contract shape', () => {
  const knownCanonicalNames = new Set<string>(
    ENTITY_FIELD_SPECS.flatMap((spec) => spec.fields.map((field) => `${spec.entityScope}.${field}`))
  )
  for (const canonicalName of Object.keys(HOST_METRICS_METRIC_DESCRIPTORS)) {
    assertEquals(
      knownCanonicalNames.has(canonicalName),
      true,
      `descriptor ${canonicalName} does not correspond to a known contract field`
    )
  }
})

test('descriptor map keys always equal their own canonicalName', () => {
  for (const [key, descriptor] of Object.entries(HOST_METRICS_METRIC_DESCRIPTORS)) {
    assertEquals(descriptor.canonicalName, key)
  }
})

// ---------------------------------------------------------------------------
// Family / per-entity capacity assertions
// ---------------------------------------------------------------------------

test('fixed-shape hostedFamily descriptor counts stay within their AE page budget', () => {
  for (const [family, cap] of Object.entries(_internal.HOSTED_FAMILY_CAPACITY)) {
    const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS).filter(
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
  for (const [family, cap] of Object.entries(_internal.PER_ENTITY_CAPACITY)) {
    const count = Object.values(HOST_METRICS_METRIC_DESCRIPTORS).filter(
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
  const oversized: Record<string, HostMetricsMetricDescriptor> = {
    ...HOST_METRICS_METRIC_DESCRIPTORS,
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
      hostedFamily: 'host.system' as HostedFamily,
      resetBehavior: 'none',
      availabilityBehavior: 'legitimate-zero',
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      sanitize: 'null',
    }
  }
  assertThrows(
    () => _internal.assertHostedFamilyCapacity(oversized),
    TypeError,
    'hostedFamily "host.system" has'
  )
})

test('assertHostedFamilyCapacity throws when a per-entity-packed family is intentionally oversized', () => {
  const oversized: Record<string, HostMetricsMetricDescriptor> = {
    ...HOST_METRICS_METRIC_DESCRIPTORS,
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
    () => _internal.assertHostedFamilyCapacity(oversized),
    TypeError,
    'hostedFamily "gpu" has'
  )
})

test('buildDescriptorMap throws on a canonicalName collision instead of silently overwriting', () => {
  const duplicate: HostMetricsMetricDescriptor = {
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
      _internal.buildDescriptorMap([
        { 'gpu.utilizationPercent': duplicate },
        { 'gpu.utilizationPercent': duplicate },
      ]),
    TypeError,
    'duplicate metric canonicalName: gpu.utilizationPercent'
  )
})

// ---------------------------------------------------------------------------
// sanitizeMetricValue clamp/sanitize behavior
// ---------------------------------------------------------------------------

test('sanitizeMetricValue clamps a percent (clamp) descriptor out of range', () => {
  assertEquals(sanitizeMetricValue('host.cpu.busyPercent', 150), 100)
  assertEquals(sanitizeMetricValue('host.cpu.busyPercent', -10), 0)
  assertEquals(sanitizeMetricValue('host.cpu.busyPercent', 42), 42)
})

test('sanitizeMetricValue nulls a non-negative (null) descriptor out of range', () => {
  assertEquals(sanitizeMetricValue('network.receiveBytesPerSecond', -1), null)
  assertEquals(sanitizeMetricValue('network.receiveBytesPerSecond', 500), 500)
})

test('sanitizeMetricValue passes null through untouched', () => {
  assertEquals(sanitizeMetricValue('hardwareSignal.value', null), null)
})

test('sanitizeMetricValue rejects non-finite values', () => {
  assertEquals(sanitizeMetricValue('hardwareSignal.value', Number.NaN), null)
  assertEquals(sanitizeMetricValue('hardwareSignal.value', Number.POSITIVE_INFINITY), null)
})

test('sanitizeMetricValue throws on an unknown canonicalName', () => {
  assertThrows(
    () => sanitizeMetricValue('not.a.real.metric', 1),
    TypeError,
    'unknown v5 metric canonicalName: not.a.real.metric'
  )
})

test('sanitizeMetricValue bounds the hardware-signal value descriptor that now carries every temperature/power reading', () => {
  assertEquals(sanitizeMetricValue('hardwareSignal.value', 71), 71)
  assertEquals(sanitizeMetricValue('hardwareSignal.value', 0), 0)
  // The family is non-negative — a sub-zero reading nulls out rather than
  // clamping, since it is a misread sensor rather than a real measurement.
  assertEquals(sanitizeMetricValue('hardwareSignal.value', -50), null)
})
