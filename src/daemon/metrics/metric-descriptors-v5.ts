/**
 * Host metrics v5 per-metric storage/query contract (control-plane only —
 * no daemon-side twin, unlike `contract-v5.ts`). Pairs with
 * `contract-v5.ts` the way v3's `metric-descriptors.ts` pairs with
 * `contract.ts`: `contract-v5.ts` owns the wire shape, this file owns
 * unit/aggregation/family/reset/availability metadata plus range and
 * sanitize behavior.
 *
 * Unlike v3, there is no `MetricPart`/19-slot-per-part allowlist coupling.
 * `hostedFamily` is informational metadata describing which conceptual
 * group a metric belongs to — physical Cloudflare Analytics Engine packing
 * is a downstream concern this file does not encode. The per-family/
 * per-entity slot ceilings asserted below exist only because AE double-index
 * pages are still finite; they are not a partition requirement the way v3's
 * `MetricPart`s were.
 *
 * `canonicalName` must be globally unique across every descriptor (it is the
 * map key). Host-scoped metrics (`host.system`/`host.io`) use their bare
 * contract field name since those never collide. Every per-entity family
 * reuses common field names across families (e.g. `utilizationPercent` on
 * both `gpu` and `block`), so entity-scoped canonical names are qualified as
 * `<entityScope>.<fieldName>` — the field-name half still matches the
 * contract for descriptor↔contract agreement checks.
 */

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

/** How out-of-range finite values are corrected before storage. */
export type MetricSanitizeBehaviorV5 = 'clamp' | 'null'

/** Logical unit a metric is expressed in (drives formatting + axis labels). */
export type MetricUnitV5 =
  | 'percent'
  | 'ratio'
  | 'bytes'
  | 'bytesPerSecond'
  | 'opsPerSecond'
  | 'count'
  | 'countPerSecond'
  | 'seconds'
  | 'celsius'
  | 'watts'
  | 'milliseconds'
  | 'rpm'
  | 'mhz'

/** Value-shape semantic — how the raw reading behaves over time. */
export type MetricSemanticV5 = 'gauge' | 'rate' | 'delta' | 'psi-percent'

/** How samples combine into a time bucket at query time. */
export type MetricAggregationV5 = 'weighted-average' | 'delta-sum' | 'max' | 'last'

/** Whether a metric is a cumulative counter needing baseline-delta handling, or not. */
export type MetricResetBehaviorV5 = 'cumulative-counter' | 'none'

/**
 * Whether an absent reading means "this host doesn't support the sensor"
 * (never render a zero) or "zero is a legitimate observed value" (e.g. no
 * swap configured).
 */
export type MetricAvailabilityBehaviorV5 = 'missing-when-unsupported' | 'legitimate-zero'

/** Conceptual metric grouping — informational only, not a storage partition. */
export type HostedFamilyV5 =
  | 'host.system'
  | 'host.io'
  | 'gpu'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'hardware.physical'
  | 'managed.ingress'
  | 'managed.database_proxy'
  | 'cpu.detail'
  | 'memory.detail'

/** Which contract entity a metric is scoped to. */
export type MetricEntityScopeV5 =
  | 'host.cpu'
  | 'host.kernel'
  | 'host.memory'
  | 'host.storage'
  | 'host.network'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'gpu'
  | 'hardwareSignal'
  | 'ingress'
  | 'databaseProxy'
  | 'cpuDetail'
  | 'memoryDetail'

export type HostMetricsMetricDescriptorV5 = {
  /** Globally unique across all descriptors — see the file-level doc comment for the naming scheme. */
  canonicalName: string
  /** The contract field name this descriptor describes, scoped within its own entity type. */
  fieldName: string
  unit: MetricUnitV5
  semantic: MetricSemanticV5
  aggregation: MetricAggregationV5
  entityScope: MetricEntityScopeV5
  hostedFamily: HostedFamilyV5
  resetBehavior: MetricResetBehaviorV5
  availabilityBehavior: MetricAvailabilityBehaviorV5
  min: number
  max: number
  sanitize: MetricSanitizeBehaviorV5
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER

/** Every canonical name is qualified by its entity scope so field-name reuse across families never collides. */
function entityCanonicalName(entityScope: MetricEntityScopeV5, fieldName: string): string {
  return `${entityScope}.${fieldName}`
}

function percent(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5,
  availabilityBehavior: MetricAvailabilityBehaviorV5 = 'missing-when-unsupported'
): HostMetricsMetricDescriptorV5 {
  return {
    canonicalName: entityCanonicalName(entityScope, fieldName),
    fieldName,
    unit: 'percent',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
    resetBehavior: 'none',
    availabilityBehavior,
    min: 0,
    max: 100,
    sanitize: 'clamp',
  }
}

function psiPercent(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return {
    canonicalName: entityCanonicalName(entityScope, fieldName),
    fieldName,
    unit: 'percent',
    semantic: 'psi-percent',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
    resetBehavior: 'none',
    availabilityBehavior: 'missing-when-unsupported',
    min: 0,
    max: 100,
    sanitize: 'clamp',
  }
}

function nonNegative(
  fieldName: string,
  meta: {
    unit: MetricUnitV5
    semantic: MetricSemanticV5
    aggregation: MetricAggregationV5
    entityScope: MetricEntityScopeV5
    hostedFamily: HostedFamilyV5
    resetBehavior?: MetricResetBehaviorV5
    availabilityBehavior?: MetricAvailabilityBehaviorV5
  }
): HostMetricsMetricDescriptorV5 {
  return {
    canonicalName: entityCanonicalName(meta.entityScope, fieldName),
    fieldName,
    unit: meta.unit,
    semantic: meta.semantic,
    aggregation: meta.aggregation,
    entityScope: meta.entityScope,
    hostedFamily: meta.hostedFamily,
    resetBehavior: meta.resetBehavior ?? 'none',
    availabilityBehavior: meta.availabilityBehavior ?? 'legitimate-zero',
    min: 0,
    max: SAFE_MAX,
    sanitize: 'null',
  }
}

function rate(
  fieldName: string,
  unit: MetricUnitV5,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return nonNegative(fieldName, {
    unit,
    semantic: 'rate',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
  })
}

/**
 * A cumulative-counter-derived field carried over the wire as a raw
 * per-interval delta (never divided by `intervalSeconds`) — `deltaSumExpressionForColumnV5`
 * sums these directly into a window total, unlike `rate()`'s
 * interval-weighted average. Used for managed-service counters
 * (`managed.ingress`/`managed.database_proxy`) where the shipped value must
 * preserve "how many happened in this interval", not "how many per second".
 */
function deltaCounter(
  fieldName: string,
  unit: MetricUnitV5,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return nonNegative(fieldName, {
    unit,
    semantic: 'delta',
    aggregation: 'delta-sum',
    entityScope,
    hostedFamily,
  })
}

function milliseconds(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return nonNegative(fieldName, {
    unit: 'milliseconds',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
  })
}

function bytesGauge(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5,
  availabilityBehavior: MetricAvailabilityBehaviorV5 = 'legitimate-zero'
): HostMetricsMetricDescriptorV5 {
  return nonNegative(fieldName, {
    unit: 'bytes',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
    availabilityBehavior,
  })
}

function countGauge(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return nonNegative(fieldName, {
    unit: 'count',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
  })
}

/** Temperatures may legitimately be negative — bounded, never clamped to 0. */
function temperature(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return {
    canonicalName: entityCanonicalName(entityScope, fieldName),
    fieldName,
    unit: 'celsius',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
    resetBehavior: 'none',
    availabilityBehavior: 'missing-when-unsupported',
    min: -100,
    max: 200,
    sanitize: 'null',
  }
}

function watts(
  fieldName: string,
  entityScope: MetricEntityScopeV5,
  hostedFamily: HostedFamilyV5
): HostMetricsMetricDescriptorV5 {
  return nonNegative(fieldName, {
    unit: 'watts',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
    availabilityBehavior: 'missing-when-unsupported',
  })
}

// ---------------------------------------------------------------------------
// host.system (§5) — HostCpuMetricsV5 + HostKernelMetricsV5 + HostMemoryMetricsV5
//
// Each host sub-object gets its own descriptor record (rather than one
// merged `Record<keyof A | keyof B | keyof C, …>`) because field names like
// `pressureSomePercent` legitimately repeat across `host.cpu` and
// `host.memory` now that they're unprefixed — a single flat key would let
// one overwrite the other. Canonical names stay globally unique via
// `entityCanonicalName`'s `<entityScope>.<fieldName>` qualification, mirroring
// the actual `host.cpu`/`host.memory`/etc. nesting in the contract type.
// ---------------------------------------------------------------------------

const HOST_CPU_DESCRIPTORS: Record<keyof HostCpuMetricsV5, HostMetricsMetricDescriptorV5> = {
  busyPercent: percent('busyPercent', 'host.cpu', 'host.system'),
  userPercent: percent('userPercent', 'host.cpu', 'host.system'),
  systemPercent: percent('systemPercent', 'host.cpu', 'host.system'),
  iowaitPercent: percent('iowaitPercent', 'host.cpu', 'host.system'),
  stealPercent: percent('stealPercent', 'host.cpu', 'host.system'),
  softirqPercent: percent('softirqPercent', 'host.cpu', 'host.system'),
  pressureSomePercent: psiPercent('pressureSomePercent', 'host.cpu', 'host.system'),
  saturatedCoreCount: countGauge('saturatedCoreCount', 'host.cpu', 'host.system'),
  procsRunning: countGauge('procsRunning', 'host.cpu', 'host.system'),
  procsBlocked: countGauge('procsBlocked', 'host.cpu', 'host.system'),
  // Packed on the host.io AE row (spare double18) — host.system's 19 slots are full.
  processCount: countGauge('processCount', 'host.cpu', 'host.io'),
}

const HOST_KERNEL_DESCRIPTORS: Record<keyof HostKernelMetricsV5, HostMetricsMetricDescriptorV5> = {
  fileHandlesUsedPercent: percent('fileHandlesUsedPercent', 'host.kernel', 'host.system'),
  conntrackUsedPercent: percent('conntrackUsedPercent', 'host.kernel', 'host.system'),
}

const HOST_MEMORY_DESCRIPTORS: Record<keyof HostMemoryMetricsV5, HostMetricsMetricDescriptorV5> = {
  usedBytes: bytesGauge('usedBytes', 'host.memory', 'host.system'),
  cachedFilesBytes: bytesGauge('cachedFilesBytes', 'host.memory', 'host.system'),
  swapUsedBytes: bytesGauge('swapUsedBytes', 'host.memory', 'host.system', 'legitimate-zero'),
  pressureSomePercent: psiPercent('pressureSomePercent', 'host.memory', 'host.system'),
  pressureFullPercent: psiPercent('pressureFullPercent', 'host.memory', 'host.system'),
  swapInBytesPerSecond: rate(
    'swapInBytesPerSecond',
    'bytesPerSecond',
    'host.memory',
    'host.system'
  ),
  swapOutBytesPerSecond: rate(
    'swapOutBytesPerSecond',
    'bytesPerSecond',
    'host.memory',
    'host.system'
  ),
  // Overflowed onto the host.io AE row: host.system's 19 slots are full
  // once v5's `cachedFilesBytes` joins `usedBytes`. This is the second
  // scope/family disagreement in the map (see `host.cpu.processCount`) —
  // `entityScope` is the contract nesting, `hostedFamily` is the AE page.
  majorPageFaultsPerSecond: rate(
    'majorPageFaultsPerSecond',
    'countPerSecond',
    'host.memory',
    'host.io'
  ),
}

// ---------------------------------------------------------------------------
// host.io (§7) — HostStorageMetricsV5 + HostNetworkMetricsV5
// ---------------------------------------------------------------------------

const HOST_STORAGE_DESCRIPTORS: Record<keyof HostStorageMetricsV5, HostMetricsMetricDescriptorV5> =
  {
    ioPressureSomePercent: psiPercent('ioPressureSomePercent', 'host.storage', 'host.io'),
    ioPressureFullPercent: psiPercent('ioPressureFullPercent', 'host.storage', 'host.io'),
    diskReadBytesPerSecond: rate(
      'diskReadBytesPerSecond',
      'bytesPerSecond',
      'host.storage',
      'host.io'
    ),
    diskWriteBytesPerSecond: rate(
      'diskWriteBytesPerSecond',
      'bytesPerSecond',
      'host.storage',
      'host.io'
    ),
    diskLatencyMs: milliseconds('diskLatencyMs', 'host.storage', 'host.io'),
    rootFilesystemAvailableBytes: bytesGauge(
      'rootFilesystemAvailableBytes',
      'host.storage',
      'host.io'
    ),
    rootFilesystemFreeInodes: countGauge('rootFilesystemFreeInodes', 'host.storage', 'host.io'),
  }

const HOST_NETWORK_DESCRIPTORS: Record<keyof HostNetworkMetricsV5, HostMetricsMetricDescriptorV5> =
  {
    tcpRetransmitPercent: percent(
      'tcpRetransmitPercent',
      'host.network',
      'host.io',
      'missing-when-unsupported'
    ),
    softnetDropsPerSecond: rate(
      'softnetDropsPerSecond',
      'countPerSecond',
      'host.network',
      'host.io'
    ),
  }

// ---------------------------------------------------------------------------
// Per-entity families. Canonical names are qualified (`<scope>.<field>`) —
// see the file-level doc comment — because field names like
// `utilizationPercent`/`temperatureCelsius` legitimately repeat across
// families (e.g. both `gpu` and `block`).
// ---------------------------------------------------------------------------

const NETWORK_DESCRIPTORS: Record<
  Exclude<keyof NetworkDeviceSampleV5, 'deviceId'>,
  HostMetricsMetricDescriptorV5
> = {
  receiveBytesPerSecond: rate('receiveBytesPerSecond', 'bytesPerSecond', 'network', 'network'),
  transmitBytesPerSecond: rate('transmitBytesPerSecond', 'bytesPerSecond', 'network', 'network'),
  receiveErrorsPerSecond: rate('receiveErrorsPerSecond', 'countPerSecond', 'network', 'network'),
  transmitErrorsPerSecond: rate('transmitErrorsPerSecond', 'countPerSecond', 'network', 'network'),
  receiveDropsPerSecond: rate('receiveDropsPerSecond', 'countPerSecond', 'network', 'network'),
  transmitDropsPerSecond: rate('transmitDropsPerSecond', 'countPerSecond', 'network', 'network'),
}

const FILESYSTEM_DESCRIPTORS: Record<
  Exclude<keyof FilesystemSampleV5, 'filesystemId'>,
  HostMetricsMetricDescriptorV5
> = {
  availableBytes: bytesGauge('availableBytes', 'filesystem', 'filesystem'),
  freeInodes: countGauge('freeInodes', 'filesystem', 'filesystem'),
}

const BLOCK_DESCRIPTORS: Record<
  Exclude<keyof BlockDeviceSampleV5, 'deviceId'>,
  HostMetricsMetricDescriptorV5
> = {
  readBytesPerSecond: rate('readBytesPerSecond', 'bytesPerSecond', 'block', 'block'),
  writeBytesPerSecond: rate('writeBytesPerSecond', 'bytesPerSecond', 'block', 'block'),
  readOpsPerSecond: rate('readOpsPerSecond', 'opsPerSecond', 'block', 'block'),
  writeOpsPerSecond: rate('writeOpsPerSecond', 'opsPerSecond', 'block', 'block'),
  readLatencyMs: milliseconds('readLatencyMs', 'block', 'block'),
  writeLatencyMs: milliseconds('writeLatencyMs', 'block', 'block'),
  utilizationPercent: percent('utilizationPercent', 'block', 'block'),
  temperatureCelsius: temperature('temperatureCelsius', 'block', 'block'),
  queueDepth: countGauge('queueDepth', 'block', 'block'),
}

const GPU_DESCRIPTORS: Record<
  Exclude<keyof GpuSampleV5, 'gpuId'>,
  HostMetricsMetricDescriptorV5
> = {
  utilizationPercent: percent('utilizationPercent', 'gpu', 'gpu'),
  memoryUsedBytes: bytesGauge('memoryUsedBytes', 'gpu', 'gpu'),
  memoryActivityPercent: percent('memoryActivityPercent', 'gpu', 'gpu'),
  temperatureCelsius: temperature('temperatureCelsius', 'gpu', 'gpu'),
  memoryTemperatureCelsius: temperature('memoryTemperatureCelsius', 'gpu', 'gpu'),
  powerWatts: watts('powerWatts', 'gpu', 'gpu'),
  pcieReceiveBytesPerSecond: rate('pcieReceiveBytesPerSecond', 'bytesPerSecond', 'gpu', 'gpu'),
  pcieTransmitBytesPerSecond: rate('pcieTransmitBytesPerSecond', 'bytesPerSecond', 'gpu', 'gpu'),
  throttlePercent: percent('throttlePercent', 'gpu', 'gpu'),
}

/**
 * Hardware signals are a dynamic-count family (arbitrary sensor kinds) — a
 * single generic descriptor covers the shared `value` field; `kind`/
 * `signalId` are string discriminators carried on the sample, not
 * independently typed metrics.
 */
const HARDWARE_SIGNAL_DESCRIPTORS: Record<
  Exclude<keyof HardwareSignalSampleV5, 'signalId' | 'kind'>,
  HostMetricsMetricDescriptorV5
> = {
  value: nonNegative('value', {
    unit: 'count',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'hardwareSignal',
    hostedFamily: 'hardware.physical',
    availabilityBehavior: 'missing-when-unsupported',
  }),
}

const INGRESS_DESCRIPTORS: Record<
  Exclude<keyof IngressSourceSampleV5, 'sourceId' | 'sourceKind'>,
  HostMetricsMetricDescriptorV5
> = {
  requests: deltaCounter('requests', 'count', 'ingress', 'managed.ingress'),
  responses2xx: deltaCounter('responses2xx', 'count', 'ingress', 'managed.ingress'),
  responses3xx: deltaCounter('responses3xx', 'count', 'ingress', 'managed.ingress'),
  responses4xx: deltaCounter('responses4xx', 'count', 'ingress', 'managed.ingress'),
  responses5xx: deltaCounter('responses5xx', 'count', 'ingress', 'managed.ingress'),
  requestErrors: deltaCounter('requestErrors', 'count', 'ingress', 'managed.ingress'),
  requestBytes: deltaCounter('requestBytes', 'bytes', 'ingress', 'managed.ingress'),
  responseBytes: deltaCounter('responseBytes', 'bytes', 'ingress', 'managed.ingress'),
  requestDurationSecondsAvg: nonNegative('requestDurationSecondsAvg', {
    unit: 'seconds',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'ingress',
    hostedFamily: 'managed.ingress',
  }),
  requestsUnder100ms: deltaCounter('requestsUnder100ms', 'count', 'ingress', 'managed.ingress'),
  requestsUnder500ms: deltaCounter('requestsUnder500ms', 'count', 'ingress', 'managed.ingress'),
  requestsUnder1s: deltaCounter('requestsUnder1s', 'count', 'ingress', 'managed.ingress'),
  requestsUnder5s: deltaCounter('requestsUnder5s', 'count', 'ingress', 'managed.ingress'),
  requestsInFlight: countGauge('requestsInFlight', 'ingress', 'managed.ingress'),
  upstreamsHealthy: countGauge('upstreamsHealthy', 'ingress', 'managed.ingress'),
  upstreamsTotal: countGauge('upstreamsTotal', 'ingress', 'managed.ingress'),
  retries: deltaCounter('retries', 'count', 'ingress', 'managed.ingress'),
}

const DATABASE_PROXY_DESCRIPTORS: Record<
  Exclude<keyof DatabaseProxySampleV5, 'sourceId' | 'sourceKind'>,
  HostMetricsMetricDescriptorV5
> = {
  queries: deltaCounter('queries', 'count', 'databaseProxy', 'managed.database_proxy'),
  slowQueries: deltaCounter('slowQueries', 'count', 'databaseProxy', 'managed.database_proxy'),
  connectionErrors: deltaCounter(
    'connectionErrors',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  clientConnections: countGauge('clientConnections', 'databaseProxy', 'managed.database_proxy'),
  backendConnections: countGauge('backendConnections', 'databaseProxy', 'managed.database_proxy'),
  backendsUp: countGauge('backendsUp', 'databaseProxy', 'managed.database_proxy'),
}

// ---------------------------------------------------------------------------
// cpu.detail (§38) / memory.detail (§40) — populated by the
// cpu-detail/memory-detail collectors. Both are host-scoped, fixed-shape
// pages. v5 removed every per-core family: `cpu.detail`'s 4 embedded
// busiest-core hotspots and the live per-core `cpu.core.live` family are
// both gone, so `cpu.detail` is 7 scalar slots rather than 19 and no
// scope needs an embedded-slot multiplier any more.
// ---------------------------------------------------------------------------

const CPU_DETAIL_DESCRIPTORS: Record<
  Exclude<keyof CpuDetailSampleV5, 'hotspots'>,
  HostMetricsMetricDescriptorV5
> = {
  averageFrequencyMHz: nonNegative('averageFrequencyMHz', {
    unit: 'mhz',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'cpuDetail',
    hostedFamily: 'cpu.detail',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  minimumFrequencyMHz: nonNegative('minimumFrequencyMHz', {
    unit: 'mhz',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'cpuDetail',
    hostedFamily: 'cpu.detail',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  maximumFrequencyMHz: nonNegative('maximumFrequencyMHz', {
    unit: 'mhz',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'cpuDetail',
    hostedFamily: 'cpu.detail',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  contextSwitchesPerSecond: rate(
    'contextSwitchesPerSecond',
    'countPerSecond',
    'cpuDetail',
    'cpu.detail'
  ),
  interruptsPerSecond: rate('interruptsPerSecond', 'countPerSecond', 'cpuDetail', 'cpu.detail'),
  forksPerSecond: rate('forksPerSecond', 'countPerSecond', 'cpuDetail', 'cpu.detail'),
  cpuIrqPercent: percent('cpuIrqPercent', 'cpuDetail', 'cpu.detail'),
}

const MEMORY_DETAIL_DESCRIPTORS: Record<keyof MemoryDetailSampleV5, HostMetricsMetricDescriptorV5> =
  {
    memoryFreeBytes: bytesGauge('memoryFreeBytes', 'memoryDetail', 'memory.detail'),
    cachedBytes: bytesGauge('cachedBytes', 'memoryDetail', 'memory.detail'),
    anonPagesBytes: bytesGauge('anonPagesBytes', 'memoryDetail', 'memory.detail'),
    slabReclaimableBytes: bytesGauge('slabReclaimableBytes', 'memoryDetail', 'memory.detail'),
    slabUnreclaimableBytes: bytesGauge('slabUnreclaimableBytes', 'memoryDetail', 'memory.detail'),
    dirtyBytes: bytesGauge('dirtyBytes', 'memoryDetail', 'memory.detail'),
    writebackBytes: bytesGauge('writebackBytes', 'memoryDetail', 'memory.detail'),
    shmemBytes: bytesGauge('shmemBytes', 'memoryDetail', 'memory.detail'),
    pageTablesBytes: bytesGauge('pageTablesBytes', 'memoryDetail', 'memory.detail'),
    kernelStackBytes: bytesGauge('kernelStackBytes', 'memoryDetail', 'memory.detail'),
    committedAsBytes: bytesGauge('committedAsBytes', 'memoryDetail', 'memory.detail'),
    commitLimitBytes: bytesGauge('commitLimitBytes', 'memoryDetail', 'memory.detail'),
    activeAnonBytes: bytesGauge('activeAnonBytes', 'memoryDetail', 'memory.detail'),
    inactiveAnonBytes: bytesGauge('inactiveAnonBytes', 'memoryDetail', 'memory.detail'),
    activeFileBytes: bytesGauge('activeFileBytes', 'memoryDetail', 'memory.detail'),
    inactiveFileBytes: bytesGauge('inactiveFileBytes', 'memoryDetail', 'memory.detail'),
    pageScanDirectPerSecond: rate(
      'pageScanDirectPerSecond',
      'countPerSecond',
      'memoryDetail',
      'memory.detail'
    ),
    pageScanKswapdPerSecond: rate(
      'pageScanKswapdPerSecond',
      'countPerSecond',
      'memoryDetail',
      'memory.detail'
    ),
    compactionStallsPerSecond: rate(
      'compactionStallsPerSecond',
      'countPerSecond',
      'memoryDetail',
      'memory.detail'
    ),
  }

/** Every per-family descriptor record, in the order they contribute to the merged map. */
const ALL_DESCRIPTOR_RECORDS: Record<string, HostMetricsMetricDescriptorV5>[] = [
  HOST_CPU_DESCRIPTORS,
  HOST_KERNEL_DESCRIPTORS,
  HOST_MEMORY_DESCRIPTORS,
  HOST_STORAGE_DESCRIPTORS,
  HOST_NETWORK_DESCRIPTORS,
  NETWORK_DESCRIPTORS,
  FILESYSTEM_DESCRIPTORS,
  BLOCK_DESCRIPTORS,
  GPU_DESCRIPTORS,
  HARDWARE_SIGNAL_DESCRIPTORS,
  INGRESS_DESCRIPTORS,
  DATABASE_PROXY_DESCRIPTORS,
  CPU_DETAIL_DESCRIPTORS,
  MEMORY_DETAIL_DESCRIPTORS,
]

/**
 * Builds the central descriptor map keyed by `canonicalName` (not by the
 * per-family record's own field-name key, which is not globally unique).
 * Throws immediately on any collision rather than silently overwriting —
 * a plain object spread across these records would otherwise let, e.g.,
 * `gpu.utilizationPercent` and `block.utilizationPercent` collide if either
 * ever lost its entity-scope qualification.
 */
function buildDescriptorMap(
  records: readonly Record<string, HostMetricsMetricDescriptorV5>[]
): Record<string, HostMetricsMetricDescriptorV5> {
  const merged: Record<string, HostMetricsMetricDescriptorV5> = {}
  for (const record of records) {
    for (const descriptor of Object.values(record)) {
      if (merged[descriptor.canonicalName]) {
        throw new TypeError(`duplicate metric canonicalName: ${descriptor.canonicalName}`)
      }
      merged[descriptor.canonicalName] = descriptor
    }
  }
  return merged
}

/**
 * Central metric descriptor map — every allowed v5 metric, keyed by its
 * globally unique `canonicalName`.
 */
export const HOST_METRICS_METRIC_DESCRIPTORS_V5: Record<string, HostMetricsMetricDescriptorV5> =
  buildDescriptorMap(ALL_DESCRIPTOR_RECORDS)

/** AE double-index page budget per fixed-shape family (one row/page per sample, not per entity). */
const HOSTED_FAMILY_CAPACITY_V5: Partial<Record<HostedFamilyV5, number>> = {
  'host.system': 19,
  'host.io': 19,
  'managed.ingress': 17,
  'managed.database_proxy': 6,
  'cpu.detail': 7,
  'memory.detail': 19,
}

/** AE double-index page budget per entity for the per-entity-packed families. */
const PER_ENTITY_CAPACITY_V5: Record<
  Extract<HostedFamilyV5, 'gpu' | 'network' | 'filesystem' | 'block'>,
  number
> = {
  gpu: 9,
  network: 6,
  filesystem: 2,
  block: 9,
}

/**
 * Per-scope AE double-slot multiplier. v4 needed this because `cpu.detail`
 * embedded 4 busiest-core hotspot slots, so one `cpuHotspot` descriptor
 * consumed 4 doubles. v5 has no embedded repeated scope at all, so every
 * scope consumes exactly the slot count its descriptors declare — the map
 * is kept (empty) so re-introducing an embedded family stays a one-line
 * change rather than a re-derivation.
 */
const EMBEDDED_SCOPE_MULTIPLIER_V5: Partial<Record<MetricEntityScopeV5, number>> = {}

const FIXED_SHAPE_FAMILIES_V5 = Object.keys(HOSTED_FAMILY_CAPACITY_V5) as HostedFamilyV5[]
const PER_ENTITY_FAMILIES_V5 = Object.keys(
  PER_ENTITY_CAPACITY_V5
) as (keyof typeof PER_ENTITY_CAPACITY_V5)[]

function descriptorsByFamily(
  descriptors: Record<string, HostMetricsMetricDescriptorV5>
): Map<HostedFamilyV5, number> {
  const counts = new Map<HostedFamilyV5, number>()
  for (const descriptor of Object.values(descriptors)) {
    const multiplier = EMBEDDED_SCOPE_MULTIPLIER_V5[descriptor.entityScope] ?? 1
    counts.set(descriptor.hostedFamily, (counts.get(descriptor.hostedFamily) ?? 0) + multiplier)
  }
  return counts
}

/**
 * Module-load invariant: every `canonicalName` across all descriptors is
 * unique. `buildDescriptorMap` already throws on construction if two
 * descriptors collide, so this re-derives the same check from the finished
 * map — a safety net against any future code that assigns into
 * `HOST_METRICS_METRIC_DESCRIPTORS_V5` directly instead of going through the
 * builder.
 */
function assertNoDuplicateCanonicalNames(
  descriptors: Record<string, HostMetricsMetricDescriptorV5>
): void {
  const seen = new Set<string>()
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.canonicalName !== key) {
      throw new TypeError(
        `descriptor map key "${key}" does not match its own canonicalName "${descriptor.canonicalName}"`
      )
    }
    if (seen.has(descriptor.canonicalName)) {
      throw new TypeError(`duplicate metric canonicalName: ${descriptor.canonicalName}`)
    }
    seen.add(descriptor.canonicalName)
  }
}

/**
 * Module-load invariant: fixed-shape families (one row/page per sample) stay
 * within their AE double-index page budget, and per-entity-packed families
 * stay within their per-entity slot budget — v5's replacement for v3's flat
 * `MAX_METRICS_PER_PART` ceiling, now scoped per conceptual family instead of
 * a shared partition.
 */
function assertHostedFamilyCapacity(
  descriptors: Record<string, HostMetricsMetricDescriptorV5> = HOST_METRICS_METRIC_DESCRIPTORS_V5
): void {
  const counts = descriptorsByFamily(descriptors)
  for (const family of FIXED_SHAPE_FAMILIES_V5) {
    const cap = HOSTED_FAMILY_CAPACITY_V5[family]!
    const count = counts.get(family) ?? 0
    if (count > cap) {
      throw new TypeError(
        `hostedFamily "${family}" has ${count} descriptors, exceeding its ${cap}-slot AE page budget`
      )
    }
  }
  for (const family of PER_ENTITY_FAMILIES_V5) {
    const cap = PER_ENTITY_CAPACITY_V5[family]
    const count = counts.get(family) ?? 0
    if (count > cap) {
      throw new TypeError(
        `hostedFamily "${family}" has ${count} descriptors, exceeding its ${cap}-slot per-entity budget`
      )
    }
  }
}

assertNoDuplicateCanonicalNames(HOST_METRICS_METRIC_DESCRIPTORS_V5)
assertHostedFamilyCapacity()

/** Exposed for tests that need to assert the throw behavior without waiting on module-load side effects. */
export const _internalV5 = {
  assertNoDuplicateCanonicalNames,
  assertHostedFamilyCapacity,
  buildDescriptorMap,
  HOSTED_FAMILY_CAPACITY_V5,
  PER_ENTITY_CAPACITY_V5,
  EMBEDDED_SCOPE_MULTIPLIER_V5,
}

/** Apply descriptor min/max + sanitize behavior to a finite metric value. */
export function sanitizeMetricValueV5(canonicalName: string, value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null

  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[canonicalName]
  if (!descriptor) {
    throw new TypeError(`unknown v5 metric canonicalName: ${canonicalName}`)
  }
  if (value < descriptor.min || value > descriptor.max) {
    if (descriptor.sanitize === 'clamp') {
      if (value < descriptor.min) return descriptor.min
      return descriptor.max
    }
    return null
  }
  return value
}
