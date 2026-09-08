/**
 * Host metrics v5 per-metric storage/query contract (control-plane only —
 * no daemon-side twin, unlike `contract.ts`). Pairs with
 * `contract.ts` the way v3's `metric-descriptors.ts` pairs with
 * `contract.ts`: `contract.ts` owns the wire shape, this file owns
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
} from './contract.ts'
import {
  STORAGE_ENGINE_FIELD_NAMES,
  STORAGE_ENGINE_KEYS,
  STORAGE_FLAT_FIELD_NAMES,
  storageEngineFieldName,
} from './contract.ts'

/** How out-of-range finite values are corrected before storage. */
export type MetricSanitizeBehavior = 'clamp' | 'null'

/** Logical unit a metric is expressed in (drives formatting + axis labels). */
export type MetricUnit =
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
  | 'days'

/** Value-shape semantic — how the raw reading behaves over time. */
export type MetricSemantic = 'gauge' | 'rate' | 'delta' | 'psi-percent'

/** How samples combine into a time bucket at query time. */
export type MetricAggregation = 'weighted-average' | 'delta-sum' | 'max' | 'last'

/** Whether a metric is a cumulative counter needing baseline-delta handling, or not. */
export type MetricResetBehavior = 'cumulative-counter' | 'none'

/**
 * Whether an absent reading means "this host doesn't support the sensor"
 * (never render a zero) or "zero is a legitimate observed value" (e.g. no
 * swap configured).
 */
export type MetricAvailabilityBehavior = 'missing-when-unsupported' | 'legitimate-zero'

/** Conceptual metric grouping — informational only, not a storage partition. */
export type HostedFamily =
  | 'host.system'
  | 'host.io'
  | 'gpu'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'hardware.physical'
  | 'managed.ingress'
  | 'managed.database_proxy'
  | 'managed.router'
  | 'managed.storage'
  | 'managed.docker'
  | 'host.diagnostics'

/** Which contract entity a metric is scoped to. */
export type MetricEntityScope =
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
  | 'router'
  | 'storage'
  | 'dockerUsage'
  | 'diagnostics'

export type HostMetricsMetricDescriptor = {
  /** Globally unique across all descriptors — see the file-level doc comment for the naming scheme. */
  canonicalName: string
  /** The contract field name this descriptor describes, scoped within its own entity type. */
  fieldName: string
  unit: MetricUnit
  semantic: MetricSemantic
  aggregation: MetricAggregation
  entityScope: MetricEntityScope
  hostedFamily: HostedFamily
  resetBehavior: MetricResetBehavior
  availabilityBehavior: MetricAvailabilityBehavior
  min: number
  max: number
  sanitize: MetricSanitizeBehavior
}

const SAFE_MAX = Number.MAX_SAFE_INTEGER

/** Every canonical name is qualified by its entity scope so field-name reuse across families never collides. */
function entityCanonicalName(entityScope: MetricEntityScope, fieldName: string): string {
  return `${entityScope}.${fieldName}`
}

function percent(
  fieldName: string,
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily,
  availabilityBehavior: MetricAvailabilityBehavior = 'missing-when-unsupported'
): HostMetricsMetricDescriptor {
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
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily
): HostMetricsMetricDescriptor {
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
    unit: MetricUnit
    semantic: MetricSemantic
    aggregation: MetricAggregation
    entityScope: MetricEntityScope
    hostedFamily: HostedFamily
    resetBehavior?: MetricResetBehavior
    availabilityBehavior?: MetricAvailabilityBehavior
  }
): HostMetricsMetricDescriptor {
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
  unit: MetricUnit,
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily
): HostMetricsMetricDescriptor {
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
 * per-interval delta (never divided by `intervalSeconds`) — `deltaSumExpressionForColumn`
 * sums these directly into a window total, unlike `rate()`'s
 * interval-weighted average. Used for managed-service counters
 * (`managed.ingress`/`managed.database_proxy`) where the shipped value must
 * preserve "how many happened in this interval", not "how many per second".
 */
function deltaCounter(
  fieldName: string,
  unit: MetricUnit,
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily
): HostMetricsMetricDescriptor {
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
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily
): HostMetricsMetricDescriptor {
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
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily,
  availabilityBehavior: MetricAvailabilityBehavior = 'legitimate-zero'
): HostMetricsMetricDescriptor {
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
  entityScope: MetricEntityScope,
  hostedFamily: HostedFamily
): HostMetricsMetricDescriptor {
  return nonNegative(fieldName, {
    unit: 'count',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope,
    hostedFamily,
  })
}

// No `temperature`/`watts` helper any more: every temperature and power
// reading in the contract is a `hardware.physical` signal, covered by the
// dynamic-count `HARDWARE_SIGNAL_DESCRIPTORS.value` descriptor below rather
// than by a per-field, per-entity descriptor of its own.

// ---------------------------------------------------------------------------
// host.system (§5) — HostCpuMetrics + HostMemoryMetrics
//
// v6 re-laid out the two universal host rows so neither family needs an
// overflow: `host.system` is exactly `host.cpu` (11) + `host.memory` (8) = 19
// doubles, and `host.kernel` moved onto `host.io` alongside storage/network.
// `entityScope` (the contract nesting) and `hostedFamily` (the AE page) now
// agree for every host field.
//
// Each host sub-object gets its own descriptor record (rather than one
// merged `Record<keyof A | keyof B | keyof C, …>`) because field names like
// `pressureSomePercent` legitimately repeat across `host.cpu` and
// `host.memory` now that they're unprefixed — a single flat key would let
// one overwrite the other. Canonical names stay globally unique via
// `entityCanonicalName`'s `<entityScope>.<fieldName>` qualification, mirroring
// the actual `host.cpu`/`host.memory`/etc. nesting in the contract type.
// ---------------------------------------------------------------------------

const HOST_CPU_DESCRIPTORS: Record<keyof HostCpuMetrics, HostMetricsMetricDescriptor> = {
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
  processCount: countGauge('processCount', 'host.cpu', 'host.system'),
}

const HOST_KERNEL_DESCRIPTORS: Record<keyof HostKernelMetrics, HostMetricsMetricDescriptor> = {
  fileHandlesUsedPercent: percent('fileHandlesUsedPercent', 'host.kernel', 'host.io'),
  conntrackUsedPercent: percent('conntrackUsedPercent', 'host.kernel', 'host.io'),
}

const HOST_MEMORY_DESCRIPTORS: Record<keyof HostMemoryMetrics, HostMetricsMetricDescriptor> = {
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
  majorPageFaultsPerSecond: rate(
    'majorPageFaultsPerSecond',
    'countPerSecond',
    'host.memory',
    'host.system'
  ),
}

// ---------------------------------------------------------------------------
// host.io (§7) — HostKernelMetrics + HostStorageMetrics + HostNetworkMetrics
// ---------------------------------------------------------------------------

const HOST_STORAGE_DESCRIPTORS: Record<keyof HostStorageMetrics, HostMetricsMetricDescriptor> =
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

const HOST_NETWORK_DESCRIPTORS: Record<keyof HostNetworkMetrics, HostMetricsMetricDescriptor> =
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
  Exclude<keyof NetworkDeviceSample, 'deviceId'>,
  HostMetricsMetricDescriptor
> = {
  receiveBytesPerSecond: rate('receiveBytesPerSecond', 'bytesPerSecond', 'network', 'network'),
  transmitBytesPerSecond: rate('transmitBytesPerSecond', 'bytesPerSecond', 'network', 'network'),
  receiveErrorsPerSecond: rate('receiveErrorsPerSecond', 'countPerSecond', 'network', 'network'),
  transmitErrorsPerSecond: rate('transmitErrorsPerSecond', 'countPerSecond', 'network', 'network'),
  receiveDropsPerSecond: rate('receiveDropsPerSecond', 'countPerSecond', 'network', 'network'),
  transmitDropsPerSecond: rate('transmitDropsPerSecond', 'countPerSecond', 'network', 'network'),
}

const FILESYSTEM_DESCRIPTORS: Record<
  Exclude<keyof FilesystemSample, 'filesystemId'>,
  HostMetricsMetricDescriptor
> = {
  availableBytes: bytesGauge('availableBytes', 'filesystem', 'filesystem'),
  freeInodes: countGauge('freeInodes', 'filesystem', 'filesystem'),
}

const BLOCK_DESCRIPTORS: Record<
  Exclude<keyof BlockDeviceSample, 'deviceId'>,
  HostMetricsMetricDescriptor
> = {
  readBytesPerSecond: rate('readBytesPerSecond', 'bytesPerSecond', 'block', 'block'),
  writeBytesPerSecond: rate('writeBytesPerSecond', 'bytesPerSecond', 'block', 'block'),
  readOpsPerSecond: rate('readOpsPerSecond', 'opsPerSecond', 'block', 'block'),
  writeOpsPerSecond: rate('writeOpsPerSecond', 'opsPerSecond', 'block', 'block'),
  readLatencyMs: milliseconds('readLatencyMs', 'block', 'block'),
  writeLatencyMs: milliseconds('writeLatencyMs', 'block', 'block'),
  utilizationPercent: percent('utilizationPercent', 'block', 'block'),
  queueDepth: countGauge('queueDepth', 'block', 'block'),
}

const GPU_DESCRIPTORS: Record<
  Exclude<keyof GpuSample, 'gpuId'>,
  HostMetricsMetricDescriptor
> = {
  utilizationPercent: percent('utilizationPercent', 'gpu', 'gpu'),
  memoryUsedBytes: bytesGauge('memoryUsedBytes', 'gpu', 'gpu'),
  memoryActivityPercent: percent('memoryActivityPercent', 'gpu', 'gpu'),
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
  Exclude<keyof HardwareSignalSample, 'signalId' | 'kind'>,
  HostMetricsMetricDescriptor
> = {
  // `min: 0` (from `nonNegative`) is deliberate for the whole family: every
  // reading it carries — CPU/board/GPU/drive temperature, CPU/GPU power — is
  // non-negative on real hardware, and a sub-zero value is far more likely a
  // misread sensor than a genuinely frozen component.

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
  Exclude<keyof IngressSourceSample, 'sourceId' | 'sourceKind'>,
  HostMetricsMetricDescriptor
> = {
  requests: deltaCounter('requests', 'count', 'ingress', 'managed.ingress'),
  responses2xx: deltaCounter('responses2xx', 'count', 'ingress', 'managed.ingress'),
  responses3xx: deltaCounter('responses3xx', 'count', 'ingress', 'managed.ingress'),
  responses4xx: deltaCounter('responses4xx', 'count', 'ingress', 'managed.ingress'),
  responses5xx: deltaCounter('responses5xx', 'count', 'ingress', 'managed.ingress'),
  requestErrors: deltaCounter('requestErrors', 'count', 'ingress', 'managed.ingress'),
  requestBytes: deltaCounter('requestBytes', 'bytes', 'ingress', 'managed.ingress'),
  responseBytes: deltaCounter('responseBytes', 'bytes', 'ingress', 'managed.ingress'),
  // A raw per-interval duration *sum*, not an average: `delta-sum` is what
  // makes `SUM(sum) / SUM(requests)` the true window mean at read time. A
  // `weighted-average` here would average per-interval sums and then divide
  // by a window-total request count — dimensionally wrong.
  requestDurationSecondsSum: deltaCounter(
    'requestDurationSecondsSum',
    'seconds',
    'ingress',
    'managed.ingress'
  ),
  // Cumulative-`le` histogram buckets (each counts every request at or under
  // its bound). `delta-sum` is exactly right: bucket counts add across
  // windows, which is why percentiles are derived from these at read time
  // rather than stored — a stored quantile could not be re-bucketed.
  bucket10ms: deltaCounter('bucket10ms', 'count', 'ingress', 'managed.ingress'),
  bucket50ms: deltaCounter('bucket50ms', 'count', 'ingress', 'managed.ingress'),
  bucket100ms: deltaCounter('bucket100ms', 'count', 'ingress', 'managed.ingress'),
  bucket500ms: deltaCounter('bucket500ms', 'count', 'ingress', 'managed.ingress'),
  bucket1s: deltaCounter('bucket1s', 'count', 'ingress', 'managed.ingress'),
  bucket5s: deltaCounter('bucket5s', 'count', 'ingress', 'managed.ingress'),
  requestsInFlight: countGauge('requestsInFlight', 'ingress', 'managed.ingress'),
  upstreamsHealthy: countGauge('upstreamsHealthy', 'ingress', 'managed.ingress'),
  upstreamsTotal: countGauge('upstreamsTotal', 'ingress', 'managed.ingress'),
  retries: deltaCounter('retries', 'count', 'ingress', 'managed.ingress'),
}

const DATABASE_PROXY_DESCRIPTORS: Record<
  Exclude<keyof DatabaseProxySample, 'sourceId' | 'sourceKind'>,
  HostMetricsMetricDescriptor
> = {
  queries: deltaCounter('queries', 'count', 'databaseProxy', 'managed.database_proxy'),
  slowQueries: deltaCounter('slowQueries', 'count', 'databaseProxy', 'managed.database_proxy'),
  // Per-interval means (time delta / query delta). ProxySQL exposes
  // cumulative time totals, not histograms, so there is no bucket set to
  // derive percentiles from the way `managed.ingress` has.
  queryLatencyMsAvg: milliseconds('queryLatencyMsAvg', 'databaseProxy', 'managed.database_proxy'),
  backendLatencyMsAvg: milliseconds(
    'backendLatencyMsAvg',
    'databaseProxy',
    'managed.database_proxy'
  ),
  activeTransactions: countGauge('activeTransactions', 'databaseProxy', 'managed.database_proxy'),
  clientConnections: countGauge('clientConnections', 'databaseProxy', 'managed.database_proxy'),
  clientConnectionsCreated: deltaCounter(
    'clientConnectionsCreated',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  clientConnectionsAborted: deltaCounter(
    'clientConnectionsAborted',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  connectionsRejectedMaxConns: deltaCounter(
    'connectionsRejectedMaxConns',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  backendConnections: countGauge('backendConnections', 'databaseProxy', 'managed.database_proxy'),
  backendConnectionsCreated: deltaCounter(
    'backendConnectionsCreated',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  backendConnectionsAborted: deltaCounter(
    'backendConnectionsAborted',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  connectionErrors: deltaCounter(
    'connectionErrors',
    'count',
    'databaseProxy',
    'managed.database_proxy'
  ),
  backendsUp: countGauge('backendsUp', 'databaseProxy', 'managed.database_proxy'),
  backendsTotal: countGauge('backendsTotal', 'databaseProxy', 'managed.database_proxy'),
  bytesFromBackends: deltaCounter(
    'bytesFromBackends',
    'bytes',
    'databaseProxy',
    'managed.database_proxy'
  ),
  bytesToBackends: deltaCounter(
    'bytesToBackends',
    'bytes',
    'databaseProxy',
    'managed.database_proxy'
  ),
}

// ---------------------------------------------------------------------------
// managed.router — the shared-hosting HTTP router (Traefik), host-wide and
// singleton. v5 packed Traefik into `managed.ingress` alongside Caddy, which
// forced both vendors onto one field set that described neither well; v6
// gives the router its own family with the service/backend/config surface
// its exposition actually answers.
//
// 12 of 19 slots, deliberately: the spare slots are held for the
// router-health fields a later phase adds (per-entrypoint splits, TLS
// handshake failures) without renumbering the read path.
// ---------------------------------------------------------------------------

const ROUTER_DESCRIPTORS: Record<keyof RouterSample, HostMetricsMetricDescriptor> = {
  backendsUp: countGauge('backendsUp', 'router', 'managed.router'),
  backendsTotal: countGauge('backendsTotal', 'router', 'managed.router'),
  servicesTotal: countGauge('servicesTotal', 'router', 'managed.router'),
  routersTotal: countGauge('routersTotal', 'router', 'managed.router'),
  retries: deltaCounter('retries', 'count', 'router', 'managed.router'),
  backendErrors5xx: deltaCounter('backendErrors5xx', 'count', 'router', 'managed.router'),
  backendLatencyMsAvg: milliseconds('backendLatencyMsAvg', 'router', 'managed.router'),
  backendRequests: deltaCounter('backendRequests', 'count', 'router', 'managed.router'),
  httpOpenConnections: countGauge('httpOpenConnections', 'router', 'managed.router'),
  configReloads: deltaCounter('configReloads', 'count', 'router', 'managed.router'),
  // Both of these are "how long until / since", read off a Unix-timestamp
  // gauge and converted by the collector. They are plain point-in-time
  // gauges, not counters: a window's value is the interval-weighted mean of
  // what the router reported, and summing them would be meaningless.
  configLastReloadAgeSeconds: nonNegative('configLastReloadAgeSeconds', {
    unit: 'seconds',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'router',
    hostedFamily: 'managed.router',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  // Days rather than seconds: the value is compared against renewal windows
  // measured in days (Let's Encrypt renews at 30), and a seconds axis would
  // render it as an unreadable eight-digit count.
  tlsCertSoonestExpiryDays: nonNegative('tlsCertSoonestExpiryDays', {
    unit: 'days',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'router',
    hostedFamily: 'managed.router',
    availabilityBehavior: 'missing-when-unsupported',
  }),
}

/** Flat `fieldName` list for `managed.router`, in declared (physical slot) order. */
export const ROUTER_FIELD_NAMES: readonly string[] = Object.values(ROUTER_DESCRIPTORS).map(
  (descriptor) => descriptor.fieldName
)

// ---------------------------------------------------------------------------
// managed.storage — host-wide managed-storage accounting: where the bytes
// went (hosting / backup / Docker / logs, used and free) plus the
// managed-database census that explains why.
//
// Ungated, like `host.diagnostics`: a host always knows where its own bytes
// went, so there is nothing for a plan to buy. 19 of 19 slots — the family
// fills its page exactly and holds no spares.
//
// The twelve per-engine descriptors flatten `StorageSample`'s nested
// `postgres`/`mysql`/`mariadb` groups to `<engine><Field>` via
// `storageEngineFieldName` — the same four readings three times over, so
// restating them as literals would be twelve chances to typo one.
// ---------------------------------------------------------------------------

function storageEngineDescriptors(): Record<string, HostMetricsMetricDescriptor> {
  const out: Record<string, HostMetricsMetricDescriptor> = {}
  for (const engine of STORAGE_ENGINE_KEYS) {
    for (const field of STORAGE_ENGINE_FIELD_NAMES) {
      const fieldName = storageEngineFieldName(engine, field)
      out[fieldName] = countGauge(fieldName, 'storage', 'managed.storage')
    }
  }
  return out
}

const STORAGE_DESCRIPTORS: Record<string, HostMetricsMetricDescriptor> = {
  // Directory usage (a bounded walk on the daemon's own slow interval), not
  // filesystem usage — `availabilityBehavior` stays `legitimate-zero` because
  // an empty backup root really is zero bytes.
  hostingUsedBytes: bytesGauge('hostingUsedBytes', 'storage', 'managed.storage'),
  backupUsedBytes: bytesGauge('backupUsedBytes', 'storage', 'managed.storage'),
  dockerUsedBytes: bytesGauge('dockerUsedBytes', 'storage', 'managed.storage'),
  logsUsedBytes: bytesGauge('logsUsedBytes', 'storage', 'managed.storage'),
  // Free space on the *containing filesystem*, so a used/free pair on one row
  // answers "can this grow" without a join. Missing when the path could not be
  // probed at all, never `0` — a full filesystem and an unreadable one are
  // different facts.
  hostingFreeBytes: bytesGauge(
    'hostingFreeBytes',
    'storage',
    'managed.storage',
    'missing-when-unsupported'
  ),
  backupFreeBytes: bytesGauge(
    'backupFreeBytes',
    'storage',
    'managed.storage',
    'missing-when-unsupported'
  ),
  logsFreeBytes: bytesGauge(
    'logsFreeBytes',
    'storage',
    'managed.storage',
    'missing-when-unsupported'
  ),
  ...storageEngineDescriptors(),
}

/** Flat `fieldName` list for `managed.storage`, in declared (physical slot) order. */
export const STORAGE_FIELD_NAMES: readonly string[] = Object.values(STORAGE_DESCRIPTORS).map(
  (descriptor) => descriptor.fieldName
)

/**
 * The seven flat `StorageSample` fields and the twelve flattened per-engine
 * ones, as separate ordered lists. The wire shape nests the engine groups
 * while storage and the AE row flatten them, so both halves are needed by
 * different consumers — exported here so no consumer restates either.
 */
export const STORAGE_FLAT_FIELD_NAME_LIST: readonly string[] = [...STORAGE_FLAT_FIELD_NAMES]

export const STORAGE_ENGINE_FIELD_NAME_LIST: readonly string[] = STORAGE_ENGINE_KEYS.flatMap(
  (engine) => STORAGE_ENGINE_FIELD_NAMES.map((field) => storageEngineFieldName(engine, field))
)

// ---------------------------------------------------------------------------
// managed.docker — Docker's own `GET /system/df` breakdown, host-wide and
// singleton. Gated by the capability plan's `managedDockerEnabled` (unlike
// `managed.storage`), since the breakdown is a managed-container feature
// rather than universal host accounting.
//
// 10 of 19 slots, deliberately: the spares are held for the per-image /
// per-volume depth a later phase adds without renumbering the read path.
// ---------------------------------------------------------------------------

const DOCKER_USAGE_DESCRIPTORS: Record<keyof DockerUsageSample, HostMetricsMetricDescriptor> = {
  layersBytes: bytesGauge('layersBytes', 'dockerUsage', 'managed.docker'),
  imagesCount: countGauge('imagesCount', 'dockerUsage', 'managed.docker'),
  imagesReclaimableBytes: bytesGauge(
    'imagesReclaimableBytes',
    'dockerUsage',
    'managed.docker'
  ),
  containersBytes: bytesGauge('containersBytes', 'dockerUsage', 'managed.docker'),
  containersCount: countGauge('containersCount', 'dockerUsage', 'managed.docker'),
  volumesBytes: bytesGauge('volumesBytes', 'dockerUsage', 'managed.docker'),
  volumesCount: countGauge('volumesCount', 'dockerUsage', 'managed.docker'),
  volumesReclaimableBytes: bytesGauge(
    'volumesReclaimableBytes',
    'dockerUsage',
    'managed.docker'
  ),
  buildCacheBytes: bytesGauge('buildCacheBytes', 'dockerUsage', 'managed.docker'),
  buildCacheReclaimableBytes: bytesGauge(
    'buildCacheReclaimableBytes',
    'dockerUsage',
    'managed.docker'
  ),
}

/** Flat `fieldName` list for `managed.docker`, in declared (physical slot) order. */
export const DOCKER_USAGE_FIELD_NAMES: readonly string[] = Object.values(
  DOCKER_USAGE_DESCRIPTORS
).map((descriptor) => descriptor.fieldName)

// ---------------------------------------------------------------------------
// host.diagnostics (§38/§40) — the merged always-on depth family, populated
// by the daemon's `collector/diagnostics.ts`. One host-scoped, fixed-shape
// page: 7 CPU frequency/scheduling scalars followed by 12 memory
// meminfo/vmstat gauges and rates, 19 doubles exactly.
//
// v5 carried these as two separately capability-gated families
// (`cpu.detail` / `memory.detail`, 2 AE rows). v6 merges them into one
// ungated row — doubles inside a row are free, so the second row was pure
// cost — and drops 7 never-charted meminfo gauges to make the merged set fit.
// No per-core surface survives from v4, so no scope needs an embedded-slot
// multiplier any more.
// ---------------------------------------------------------------------------

const DIAGNOSTICS_CPU_DESCRIPTORS: Record<
  keyof DiagnosticsCpuSample,
  HostMetricsMetricDescriptor
> = {
  averageFrequencyMHz: nonNegative('averageFrequencyMHz', {
    unit: 'mhz',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'diagnostics',
    hostedFamily: 'host.diagnostics',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  minimumFrequencyMHz: nonNegative('minimumFrequencyMHz', {
    unit: 'mhz',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'diagnostics',
    hostedFamily: 'host.diagnostics',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  maximumFrequencyMHz: nonNegative('maximumFrequencyMHz', {
    unit: 'mhz',
    semantic: 'gauge',
    aggregation: 'weighted-average',
    entityScope: 'diagnostics',
    hostedFamily: 'host.diagnostics',
    availabilityBehavior: 'missing-when-unsupported',
  }),
  contextSwitchesPerSecond: rate(
    'contextSwitchesPerSecond',
    'countPerSecond',
    'diagnostics',
    'host.diagnostics'
  ),
  interruptsPerSecond: rate(
    'interruptsPerSecond',
    'countPerSecond',
    'diagnostics',
    'host.diagnostics'
  ),
  forksPerSecond: rate('forksPerSecond', 'countPerSecond', 'diagnostics', 'host.diagnostics'),
  cpuIrqPercent: percent('cpuIrqPercent', 'diagnostics', 'host.diagnostics'),
}

const DIAGNOSTICS_MEMORY_DESCRIPTORS: Record<
  keyof DiagnosticsMemorySample,
  HostMetricsMetricDescriptor
> = {
  memoryFreeBytes: bytesGauge('memoryFreeBytes', 'diagnostics', 'host.diagnostics'),
  cachedBytes: bytesGauge('cachedBytes', 'diagnostics', 'host.diagnostics'),
  anonPagesBytes: bytesGauge('anonPagesBytes', 'diagnostics', 'host.diagnostics'),
  slabReclaimableBytes: bytesGauge('slabReclaimableBytes', 'diagnostics', 'host.diagnostics'),
  slabUnreclaimableBytes: bytesGauge('slabUnreclaimableBytes', 'diagnostics', 'host.diagnostics'),
  dirtyBytes: bytesGauge('dirtyBytes', 'diagnostics', 'host.diagnostics'),
  writebackBytes: bytesGauge('writebackBytes', 'diagnostics', 'host.diagnostics'),
  shmemBytes: bytesGauge('shmemBytes', 'diagnostics', 'host.diagnostics'),
  committedAsBytes: bytesGauge('committedAsBytes', 'diagnostics', 'host.diagnostics'),
  pageScanDirectPerSecond: rate(
    'pageScanDirectPerSecond',
    'countPerSecond',
    'diagnostics',
    'host.diagnostics'
  ),
  pageScanKswapdPerSecond: rate(
    'pageScanKswapdPerSecond',
    'countPerSecond',
    'diagnostics',
    'host.diagnostics'
  ),
  compactionStallsPerSecond: rate(
    'compactionStallsPerSecond',
    'countPerSecond',
    'diagnostics',
    'host.diagnostics'
  ),
}

/**
 * The merged family, CPU half first — this is the order every consumer packs
 * and renders in (`field-map.ts`'s 19 AE double slots, the OpenAPI request
 * schema, the UI's panel order).
 */
const DIAGNOSTICS_DESCRIPTORS: Record<string, HostMetricsMetricDescriptor> = {
  ...DIAGNOSTICS_CPU_DESCRIPTORS,
  ...DIAGNOSTICS_MEMORY_DESCRIPTORS,
}

/**
 * The `diagnostics` scope's two halves as ordered `fieldName` lists. The
 * scope is single (both halves ride one AE row and one canonical-name
 * prefix), but storage and the wire shape still split by half — DuckDB puts
 * the CPU fields on the host row and the memory fields in their own
 * singleton table, and the wire contract nests them as
 * `diagnostics.cpu`/`diagnostics.memory`. Exported so no consumer has to
 * restate either list.
 */
export const DIAGNOSTICS_CPU_FIELD_NAMES: readonly string[] = Object.values(
  DIAGNOSTICS_CPU_DESCRIPTORS
).map((descriptor) => descriptor.fieldName)

export const DIAGNOSTICS_MEMORY_FIELD_NAMES: readonly string[] = Object.values(
  DIAGNOSTICS_MEMORY_DESCRIPTORS
).map((descriptor) => descriptor.fieldName)

/** Every per-family descriptor record, in the order they contribute to the merged map. */
const ALL_DESCRIPTOR_RECORDS: Record<string, HostMetricsMetricDescriptor>[] = [
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
  ROUTER_DESCRIPTORS,
  STORAGE_DESCRIPTORS,
  DOCKER_USAGE_DESCRIPTORS,
  DIAGNOSTICS_DESCRIPTORS,
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
  records: readonly Record<string, HostMetricsMetricDescriptor>[]
): Record<string, HostMetricsMetricDescriptor> {
  const merged: Record<string, HostMetricsMetricDescriptor> = {}
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
export const HOST_METRICS_METRIC_DESCRIPTORS: Record<string, HostMetricsMetricDescriptor> =
  buildDescriptorMap(ALL_DESCRIPTOR_RECORDS)

/** AE double-index page budget per fixed-shape family (one row/page per sample, not per entity). */
const HOSTED_FAMILY_CAPACITY: Partial<Record<HostedFamily, number>> = {
  'host.system': 19,
  'host.io': 19,
  'managed.ingress': 19,
  'managed.database_proxy': 17,
  'managed.router': 12,
  'managed.storage': 19,
  'managed.docker': 10,
  'host.diagnostics': 19,
}

/** AE double-index page budget per entity for the per-entity-packed families. */
const PER_ENTITY_CAPACITY: Record<
  Extract<HostedFamily, 'gpu' | 'network' | 'filesystem' | 'block'>,
  number
> = {
  gpu: 6,
  network: 6,
  filesystem: 2,
  block: 8,
}

/**
 * Per-scope AE double-slot multiplier. v4 needed this because the old
 * `cpu.detail` family embedded 4 busiest-core hotspot slots, so one
 * `cpuHotspot` descriptor consumed 4 doubles. v5 removed every per-core
 * surface, so no scope has an embedded repeated shape and every scope
 * consumes exactly the slot count its descriptors declare — the map is kept
 * (empty) so re-introducing an embedded family stays a one-line change
 * rather than a re-derivation.
 */
const EMBEDDED_SCOPE_MULTIPLIER: Partial<Record<MetricEntityScope, number>> = {}

const FIXED_SHAPE_FAMILIES = Object.keys(HOSTED_FAMILY_CAPACITY) as HostedFamily[]
const PER_ENTITY_FAMILIES = Object.keys(
  PER_ENTITY_CAPACITY
) as (keyof typeof PER_ENTITY_CAPACITY)[]

function descriptorsByFamily(
  descriptors: Record<string, HostMetricsMetricDescriptor>
): Map<HostedFamily, number> {
  const counts = new Map<HostedFamily, number>()
  for (const descriptor of Object.values(descriptors)) {
    const multiplier = EMBEDDED_SCOPE_MULTIPLIER[descriptor.entityScope] ?? 1
    counts.set(descriptor.hostedFamily, (counts.get(descriptor.hostedFamily) ?? 0) + multiplier)
  }
  return counts
}

/**
 * Module-load invariant: every `canonicalName` across all descriptors is
 * unique. `buildDescriptorMap` already throws on construction if two
 * descriptors collide, so this re-derives the same check from the finished
 * map — a safety net against any future code that assigns into
 * `HOST_METRICS_METRIC_DESCRIPTORS` directly instead of going through the
 * builder.
 */
function assertNoDuplicateCanonicalNames(
  descriptors: Record<string, HostMetricsMetricDescriptor>
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
  descriptors: Record<string, HostMetricsMetricDescriptor> = HOST_METRICS_METRIC_DESCRIPTORS
): void {
  const counts = descriptorsByFamily(descriptors)
  for (const family of FIXED_SHAPE_FAMILIES) {
    const cap = HOSTED_FAMILY_CAPACITY[family]!
    const count = counts.get(family) ?? 0
    if (count > cap) {
      throw new TypeError(
        `hostedFamily "${family}" has ${count} descriptors, exceeding its ${cap}-slot AE page budget`
      )
    }
  }
  for (const family of PER_ENTITY_FAMILIES) {
    const cap = PER_ENTITY_CAPACITY[family]
    const count = counts.get(family) ?? 0
    if (count > cap) {
      throw new TypeError(
        `hostedFamily "${family}" has ${count} descriptors, exceeding its ${cap}-slot per-entity budget`
      )
    }
  }
}

assertNoDuplicateCanonicalNames(HOST_METRICS_METRIC_DESCRIPTORS)
assertHostedFamilyCapacity()

/** Exposed for tests that need to assert the throw behavior without waiting on module-load side effects. */
export const _internal = {
  assertNoDuplicateCanonicalNames,
  assertHostedFamilyCapacity,
  buildDescriptorMap,
  HOSTED_FAMILY_CAPACITY,
  PER_ENTITY_CAPACITY,
  EMBEDDED_SCOPE_MULTIPLIER,
}

/** Apply descriptor min/max + sanitize behavior to a finite metric value. */
export function sanitizeMetricValue(canonicalName: string, value: number | null): number | null {
  if (value === null) return null
  if (!Number.isFinite(value)) return null

  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[canonicalName]
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
