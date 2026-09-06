/**
 * Host metrics v4 per-metric storage/query contract (control-plane only —
 * no daemon-side twin, unlike `contract-v4.ts`). Pairs with
 * `contract-v4.ts` the way v3's `metric-descriptors.ts` pairs with
 * `contract.ts`: `contract-v4.ts` owns the wire shape, this file owns
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

/** How out-of-range finite values are corrected before storage. */
export type MetricSanitizeBehaviorV4 = 'clamp' | 'null'

/** Logical unit a metric is expressed in (drives formatting + axis labels). */
export type MetricUnitV4 =
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
export type MetricSemanticV4 = 'gauge' | 'rate' | 'delta' | 'psi-percent'

/** How samples combine into a time bucket at query time. */
export type MetricAggregationV4 = 'weighted-average' | 'delta-sum' | 'max' | 'last'

/** Whether a metric is a cumulative counter needing baseline-delta handling, or not. */
export type MetricResetBehaviorV4 = 'cumulative-counter' | 'none'

/**
 * Whether an absent reading means "this host doesn't support the sensor"
 * (never render a zero) or "zero is a legitimate observed value" (e.g. no
 * swap configured).
 */
export type MetricAvailabilityBehaviorV4 = 'missing-when-unsupported' | 'legitimate-zero'

/** Conceptual metric grouping — informational only, not a storage partition. */
export type HostedFamilyV4 =
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
  | 'cpu.core.live'

/** Which contract entity a metric is scoped to. */
export type MetricEntityScopeV4 =
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
  | 'cpuHotspot'
  | 'memoryDetail'
  | 'cpuCore'

export type HostMetricsMetricDescriptorV4 = {
  /** Globally unique across all descriptors — see the file-level doc comment for the naming scheme. */
  canonicalName: string
  /** The contract field name this descriptor describes, scoped within its own entity type. */
  fieldName: string
  unit: MetricUnitV4
  semantic: MetricSemanticV4
  aggregation: MetricAggregationV4
  entityScope: MetricEntityScopeV4
  hostedFamily: HostedFamilyV4
  resetBehavior: MetricResetBehaviorV4
  availabilityBehavior: MetricAvailabilityBehaviorV4
  min: number
  max: number
  sanitize: MetricSanitizeBehaviorV4
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER

/** Every canonical name is qualified by its entity scope so field-name reuse across families never collides. */
function entityCanonicalName(entityScope: MetricEntityScopeV4, fieldName: string): string {
  return `${entityScope}.${fieldName}`
}

function percent(
  fieldName: string,
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4,
  availabilityBehavior: MetricAvailabilityBehaviorV4 = 'missing-when-unsupported'
): HostMetricsMetricDescriptorV4 {
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
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
    unit: MetricUnitV4
    semantic: MetricSemanticV4
    aggregation: MetricAggregationV4
    entityScope: MetricEntityScopeV4
    hostedFamily: HostedFamilyV4
    resetBehavior?: MetricResetBehaviorV4
    availabilityBehavior?: MetricAvailabilityBehaviorV4
  }
): HostMetricsMetricDescriptorV4 {
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
  unit: MetricUnitV4,
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
 * per-interval delta (never divided by `intervalSeconds`) — `deltaSumExpressionForColumnV4`
 * sums these directly into a window total, unlike `rate()`'s
 * interval-weighted average. Used for managed-service counters
 * (`managed.ingress`/`managed.database_proxy`) where the shipped value must
 * preserve "how many happened in this interval", not "how many per second".
 */
function deltaCounter(
  fieldName: string,
  unit: MetricUnitV4,
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4,
  availabilityBehavior: MetricAvailabilityBehaviorV4 = 'legitimate-zero'
): HostMetricsMetricDescriptorV4 {
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
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
  entityScope: MetricEntityScopeV4,
  hostedFamily: HostedFamilyV4
): HostMetricsMetricDescriptorV4 {
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
// host.system (§5) — HostCpuMetricsV4 + HostKernelMetricsV4 + HostMemoryMetricsV4
//
// Each host sub-object gets its own descriptor record (rather than one
// merged `Record<keyof A | keyof B | keyof C, …>`) because field names like
// `pressureSomePercent` legitimately repeat across `host.cpu` and
// `host.memory` now that they're unprefixed — a single flat key would let
// one overwrite the other. Canonical names stay globally unique via
// `entityCanonicalName`'s `<entityScope>.<fieldName>` qualification, mirroring
// the actual `host.cpu`/`host.memory`/etc. nesting in the contract type.
// ---------------------------------------------------------------------------

const HOST_CPU_DESCRIPTORS: Record<keyof HostCpuMetricsV4, HostMetricsMetricDescriptorV4> = {
  busyPercent: percent('busyPercent', 'host.cpu', 'host.system'),
  userPercent: percent('userPercent', 'host.cpu', 'host.system'),
  systemPercent: percent('systemPercent', 'host.cpu', 'host.system'),
  iowaitPercent: percent('iowaitPercent', 'host.cpu', 'host.system'),
  stealPercent: percent('stealPercent', 'host.cpu', 'host.system'),
  softirqPercent: percent('softirqPercent', 'host.cpu', 'host.system'),
  pressureSomePercent: psiPercent('pressureSomePercent', 'host.cpu', 'host.system'),
  maxCoreBusyPercent: percent('maxCoreBusyPercent', 'host.cpu', 'host.system'),
  procsRunning: countGauge('procsRunning', 'host.cpu', 'host.system'),
  procsBlocked: countGauge('procsBlocked', 'host.cpu', 'host.system'),
  // Packed on the host.io AE row (spare double18) — host.system's 19 slots are full.
  processCount: countGauge('processCount', 'host.cpu', 'host.io'),
}

const HOST_KERNEL_DESCRIPTORS: Record<keyof HostKernelMetricsV4, HostMetricsMetricDescriptorV4> = {
  fileHandlesUsedPercent: percent('fileHandlesUsedPercent', 'host.kernel', 'host.system'),
  conntrackUsedPercent: percent('conntrackUsedPercent', 'host.kernel', 'host.system'),
}

const HOST_MEMORY_DESCRIPTORS: Record<keyof HostMemoryMetricsV4, HostMetricsMetricDescriptorV4> = {
  availableBytes: bytesGauge('availableBytes', 'host.memory', 'host.system'),
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
  majorPageFaultsPerSecond: rate(
    'majorPageFaultsPerSecond',
    'countPerSecond',
    'host.memory',
    'host.system'
  ),
}

// ---------------------------------------------------------------------------
// host.io (§7) — HostStorageMetricsV4 + HostNetworkMetricsV4
// ---------------------------------------------------------------------------

const HOST_STORAGE_DESCRIPTORS: Record<keyof HostStorageMetricsV4, HostMetricsMetricDescriptorV4> =
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
    diskReadLatencyMs: milliseconds('diskReadLatencyMs', 'host.storage', 'host.io'),
    diskWriteLatencyMs: milliseconds('diskWriteLatencyMs', 'host.storage', 'host.io'),
    maxBlockDeviceUtilPercent: percent('maxBlockDeviceUtilPercent', 'host.storage', 'host.io'),
    rootFilesystemAvailableBytes: bytesGauge(
      'rootFilesystemAvailableBytes',
      'host.storage',
      'host.io'
    ),
    rootFilesystemFreeInodes: countGauge('rootFilesystemFreeInodes', 'host.storage', 'host.io'),
  }

const HOST_NETWORK_DESCRIPTORS: Record<keyof HostNetworkMetricsV4, HostMetricsMetricDescriptorV4> =
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
  Exclude<keyof NetworkDeviceSampleV4, 'deviceId'>,
  HostMetricsMetricDescriptorV4
> = {
  receiveBytesPerSecond: rate('receiveBytesPerSecond', 'bytesPerSecond', 'network', 'network'),
  transmitBytesPerSecond: rate('transmitBytesPerSecond', 'bytesPerSecond', 'network', 'network'),
  receiveErrorsPerSecond: rate('receiveErrorsPerSecond', 'countPerSecond', 'network', 'network'),
  transmitErrorsPerSecond: rate('transmitErrorsPerSecond', 'countPerSecond', 'network', 'network'),
  receiveDropsPerSecond: rate('receiveDropsPerSecond', 'countPerSecond', 'network', 'network'),
  transmitDropsPerSecond: rate('transmitDropsPerSecond', 'countPerSecond', 'network', 'network'),
}

const FILESYSTEM_DESCRIPTORS: Record<
  Exclude<keyof FilesystemSampleV4, 'filesystemId'>,
  HostMetricsMetricDescriptorV4
> = {
  availableBytes: bytesGauge('availableBytes', 'filesystem', 'filesystem'),
  freeInodes: countGauge('freeInodes', 'filesystem', 'filesystem'),
}

const BLOCK_DESCRIPTORS: Record<
  Exclude<keyof BlockDeviceSampleV4, 'deviceId'>,
  HostMetricsMetricDescriptorV4
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
  Exclude<keyof GpuSampleV4, 'gpuId'>,
  HostMetricsMetricDescriptorV4
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
  Exclude<keyof HardwareSignalSampleV4, 'signalId' | 'kind'>,
  HostMetricsMetricDescriptorV4
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
  Exclude<keyof IngressSourceSampleV4, 'sourceId' | 'sourceKind'>,
  HostMetricsMetricDescriptorV4
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
  Exclude<keyof DatabaseProxySampleV4, 'sourceId' | 'sourceKind'>,
  HostMetricsMetricDescriptorV4
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
// cpu.detail (§38) / memory.detail (§40) / cpu.core.live — populated by the
// cpu-detail/memory-detail/cpu-core-live collectors. `cpu.detail` embeds 4
// busiest-core hotspots (own entity scope `cpuHotspot`, still packed inside
// the fixed-shape `cpu.detail` page — see `EMBEDDED_SCOPE_MULTIPLIER_V4`
// below) alongside 7 host-wide scalar fields. `cpu.core.live` is a
// per-entity-packed family, live sessions only, one entry per online core.
// ---------------------------------------------------------------------------

const CPU_HOTSPOT_DESCRIPTORS: Record<
  Exclude<keyof CpuHotspotSampleV4, 'coreId'>,
  HostMetricsMetricDescriptorV4
> = {
  busyPercent: percent('busyPercent', 'cpuHotspot', 'cpu.detail'),
  iowaitPercent: percent('iowaitPercent', 'cpuHotspot', 'cpu.detail'),
  stealPercent: percent('stealPercent', 'cpuHotspot', 'cpu.detail'),
}

const CPU_DETAIL_DESCRIPTORS: Record<
  Exclude<keyof CpuDetailSampleV4, 'hotspots'>,
  HostMetricsMetricDescriptorV4
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

const CPU_CORE_LIVE_DESCRIPTORS: Record<
  Exclude<keyof CpuCoreLiveSampleV4, 'coreId'>,
  HostMetricsMetricDescriptorV4
> = {
  busyPercent: percent('busyPercent', 'cpuCore', 'cpu.core.live'),
  iowaitPercent: percent('iowaitPercent', 'cpuCore', 'cpu.core.live'),
  stealPercent: percent('stealPercent', 'cpuCore', 'cpu.core.live'),
}

const MEMORY_DETAIL_DESCRIPTORS: Record<keyof MemoryDetailSampleV4, HostMetricsMetricDescriptorV4> =
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
const ALL_DESCRIPTOR_RECORDS: Record<string, HostMetricsMetricDescriptorV4>[] = [
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
  CPU_HOTSPOT_DESCRIPTORS,
  CPU_DETAIL_DESCRIPTORS,
  CPU_CORE_LIVE_DESCRIPTORS,
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
  records: readonly Record<string, HostMetricsMetricDescriptorV4>[]
): Record<string, HostMetricsMetricDescriptorV4> {
  const merged: Record<string, HostMetricsMetricDescriptorV4> = {}
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
 * Central metric descriptor map — every allowed v4 metric, keyed by its
 * globally unique `canonicalName`.
 */
export const HOST_METRICS_METRIC_DESCRIPTORS_V4: Record<string, HostMetricsMetricDescriptorV4> =
  buildDescriptorMap(ALL_DESCRIPTOR_RECORDS)

/** AE double-index page budget per fixed-shape family (one row/page per sample, not per entity). */
const HOSTED_FAMILY_CAPACITY_V4: Partial<Record<HostedFamilyV4, number>> = {
  'host.system': 19,
  'host.io': 19,
  'managed.ingress': 17,
  'managed.database_proxy': 6,
  'cpu.detail': 19,
  'memory.detail': 19,
}

/** AE double-index page budget per entity for the per-entity-packed families. */
const PER_ENTITY_CAPACITY_V4: Record<
  Extract<HostedFamilyV4, 'gpu' | 'network' | 'filesystem' | 'block' | 'cpu.core.live'>,
  number
> = {
  gpu: 9,
  network: 6,
  filesystem: 2,
  block: 9,
  'cpu.core.live': 3,
}

/**
 * `cpuHotspot` descriptors describe one embedded hotspot slot's fields, but
 * `cpu.detail`'s fixed-shape page embeds 4 hotspots (the daemon's 4 busiest
 * cores) — so each `cpuHotspot` descriptor actually consumes 4 AE double
 * slots in that page, not 1. Every other scope consumes exactly the slot
 * count its descriptors declare.
 */
const EMBEDDED_SCOPE_MULTIPLIER_V4: Partial<Record<MetricEntityScopeV4, number>> = {
  cpuHotspot: 4,
}

const FIXED_SHAPE_FAMILIES_V4 = Object.keys(HOSTED_FAMILY_CAPACITY_V4) as HostedFamilyV4[]
const PER_ENTITY_FAMILIES_V4 = Object.keys(
  PER_ENTITY_CAPACITY_V4
) as (keyof typeof PER_ENTITY_CAPACITY_V4)[]

function descriptorsByFamily(
  descriptors: Record<string, HostMetricsMetricDescriptorV4>
): Map<HostedFamilyV4, number> {
  const counts = new Map<HostedFamilyV4, number>()
  for (const descriptor of Object.values(descriptors)) {
    const multiplier = EMBEDDED_SCOPE_MULTIPLIER_V4[descriptor.entityScope] ?? 1
    counts.set(descriptor.hostedFamily, (counts.get(descriptor.hostedFamily) ?? 0) + multiplier)
  }
  return counts
}

/**
 * Module-load invariant: every `canonicalName` across all descriptors is
 * unique. `buildDescriptorMap` already throws on construction if two
 * descriptors collide, so this re-derives the same check from the finished
 * map — a safety net against any future code that assigns into
 * `HOST_METRICS_METRIC_DESCRIPTORS_V4` directly instead of going through the
 * builder.
 */
function assertNoDuplicateCanonicalNames(
  descriptors: Record<string, HostMetricsMetricDescriptorV4>
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
 * stay within their per-entity slot budget — v4's replacement for v3's flat
 * `MAX_METRICS_PER_PART` ceiling, now scoped per conceptual family instead of
 * a shared partition.
 */
function assertHostedFamilyCapacity(
  descriptors: Record<string, HostMetricsMetricDescriptorV4> = HOST_METRICS_METRIC_DESCRIPTORS_V4
): void {
  const counts = descriptorsByFamily(descriptors)
  for (const family of FIXED_SHAPE_FAMILIES_V4) {
    const cap = HOSTED_FAMILY_CAPACITY_V4[family]!
    const count = counts.get(family) ?? 0
    if (count > cap) {
      throw new TypeError(
        `hostedFamily "${family}" has ${count} descriptors, exceeding its ${cap}-slot AE page budget`
      )
    }
  }
  for (const family of PER_ENTITY_FAMILIES_V4) {
    const cap = PER_ENTITY_CAPACITY_V4[family]
    const count = counts.get(family) ?? 0
    if (count > cap) {
      throw new TypeError(
        `hostedFamily "${family}" has ${count} descriptors, exceeding its ${cap}-slot per-entity budget`
      )
    }
  }
}

assertNoDuplicateCanonicalNames(HOST_METRICS_METRIC_DESCRIPTORS_V4)
assertHostedFamilyCapacity()

/** Exposed for tests that need to assert the throw behavior without waiting on module-load side effects. */
export const _internalV4 = {
  assertNoDuplicateCanonicalNames,
  assertHostedFamilyCapacity,
  buildDescriptorMap,
  HOSTED_FAMILY_CAPACITY_V4,
  PER_ENTITY_CAPACITY_V4,
  EMBEDDED_SCOPE_MULTIPLIER_V4,
}

/** Apply descriptor min/max + sanitize behavior to a finite metric value. */
export function sanitizeMetricValueV4(canonicalName: string, value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null

  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V4[canonicalName]
  if (!descriptor) {
    throw new TypeError(`unknown v4 metric canonicalName: ${canonicalName}`)
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
