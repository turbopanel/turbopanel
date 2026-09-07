/**
 * Host metrics wire contract v5 (daemon → instance). Mirrored in daemon
 * `src/metrics/contract-v5.ts`.
 *
 * v5 drops the v3 `MetricPart`/19-slot-per-part allowlist coupling entirely.
 * Metrics are grouped by entity (host, network device, filesystem, block
 * device, GPU, hardware signal, ingress source, database proxy) instead of a
 * flat key list, every leaf value is `number | null` (missing is always
 * `null`, never coerced to `0`), and entities carry a stable logical id
 * instead of relying on positional/part membership. Physical storage
 * layout (Cloudflare Analytics Engine packing) is entirely downstream of
 * this file — see `metric-descriptors-v5.ts` (instance repo, control-plane
 * only) for the per-metric unit/aggregation/family contract this type
 * pairs with.
 *
 * v3's `contract.ts` (schema version 3) is untouched and continues to be the
 * live wire format until later phases cut over.
 */

export const METRICS_SCHEMA_VERSION_V5 = 5 as const

/** Sampling cadence the daemon collected under — baseline (steady) or live (on-demand fast). */
export type MetricsCollectionModeV5 = 'baseline' | 'live'

/** Maps every non-string field of `T` to `number | null` — the sanitized-output shape for a raw input `T`. */
type RawNumeric<T> = {
  [K in keyof T]: T[K] extends string ? T[K] : number | null
}

// ---------------------------------------------------------------------------
// Host-scoped metrics (no entity id — one value per sample), grouped by
// subsystem. Together `cpu` + `kernel` + `memory` + `storage` + `network`
// cover the universal host.system/host.io metric families.
// ---------------------------------------------------------------------------

export type HostCpuMetricsV5 = {
  busyPercent: number | null
  userPercent: number | null
  systemPercent: number | null
  iowaitPercent: number | null
  stealPercent: number | null
  softirqPercent: number | null
  pressureSomePercent: number | null
  saturatedCoreCount: number | null
  procsRunning: number | null
  procsBlocked: number | null
  /** Total `/proc` PID directories — not the run-queue `procs_running` gauge. */
  processCount: number | null
}

export type HostKernelMetricsV5 = {
  fileHandlesUsedPercent: number | null
  conntrackUsedPercent: number | null
}

export type HostMemoryMetricsV5 = {
  usedBytes: number | null
  cachedFilesBytes: number | null
  swapUsedBytes: number | null
  pressureSomePercent: number | null
  pressureFullPercent: number | null
  swapInBytesPerSecond: number | null
  swapOutBytesPerSecond: number | null
  majorPageFaultsPerSecond: number | null
}

export type HostStorageMetricsV5 = {
  ioPressureSomePercent: number | null
  ioPressureFullPercent: number | null
  diskReadBytesPerSecond: number | null
  diskWriteBytesPerSecond: number | null
  diskLatencyMs: number | null
  rootFilesystemAvailableBytes: number | null
  rootFilesystemFreeInodes: number | null
}

export type HostNetworkMetricsV5 = {
  tcpRetransmitPercent: number | null
  softnetDropsPerSecond: number | null
}

export type HostMetricsV5 = {
  cpu: HostCpuMetricsV5
  kernel: HostKernelMetricsV5
  memory: HostMemoryMetricsV5
  storage: HostStorageMetricsV5
  network: HostNetworkMetricsV5
}

// ---------------------------------------------------------------------------
// Per-entity metrics. Every type's stable logical id comes first; every
// other field is `number | null` (or `string` for a kind/source
// discriminator).
// ---------------------------------------------------------------------------

export type NetworkDeviceSampleV5 = {
  deviceId: string
  receiveBytesPerSecond: number | null
  transmitBytesPerSecond: number | null
  receiveErrorsPerSecond: number | null
  transmitErrorsPerSecond: number | null
  receiveDropsPerSecond: number | null
  transmitDropsPerSecond: number | null
}

export type FilesystemSampleV5 = {
  filesystemId: string
  availableBytes: number | null
  freeInodes: number | null
}

export type BlockDeviceSampleV5 = {
  deviceId: string
  readBytesPerSecond: number | null
  writeBytesPerSecond: number | null
  readOpsPerSecond: number | null
  writeOpsPerSecond: number | null
  readLatencyMs: number | null
  writeLatencyMs: number | null
  utilizationPercent: number | null
  temperatureCelsius: number | null
  queueDepth: number | null
}

export type GpuSampleV5 = {
  gpuId: string
  utilizationPercent: number | null
  memoryUsedBytes: number | null
  memoryActivityPercent: number | null
  temperatureCelsius: number | null
  memoryTemperatureCelsius: number | null
  powerWatts: number | null
  pcieReceiveBytesPerSecond: number | null
  pcieTransmitBytesPerSecond: number | null
  throttlePercent: number | null
}

/** Conservative physical sensor reading (CPU package temp/power, storage temp, trustworthy board temps, plus the synthetic hottest-core/thermal-throttled CPU signals) — dynamic count per host, not a fixed family. Never fan RPM or GPU temp/power (GPU rides `GpuSampleV5` instead). */
export type HardwareSignalSampleV5 = {
  signalId: string
  kind: string
  value: number | null
}

export type IngressSourceSampleV5 = {
  sourceId: string
  /** Discriminates which ingress adapter produced this source (`"caddy"` / `"traefik"`). */
  sourceKind: string
  requests: number | null
  responses2xx: number | null
  responses3xx: number | null
  responses4xx: number | null
  responses5xx: number | null
  requestErrors: number | null
  requestBytes: number | null
  responseBytes: number | null
  requestDurationSecondsAvg: number | null
  requestsUnder100ms: number | null
  requestsUnder500ms: number | null
  requestsUnder1s: number | null
  requestsUnder5s: number | null
  requestsInFlight: number | null
  upstreamsHealthy: number | null
  upstreamsTotal: number | null
  retries: number | null
}

export type DatabaseProxySampleV5 = {
  sourceId: string
  /** Discriminates which database-proxy adapter produced this source (`"proxysql"`). */
  sourceKind: string
  queries: number | null
  slowQueries: number | null
  connectionErrors: number | null
  clientConnections: number | null
  backendConnections: number | null
  backendsUp: number | null
}

/**
 * Host-wide CPU frequency/scheduling counters. v5 carries no per-core
 * breakdown at all: the busiest-core hotspots and the live per-core family
 * were removed outright, so a 64-core host costs exactly the same rows as a
 * 2-core one. `host.cpu.saturatedCoreCount` is the host-scoped scalar that
 * replaced them.
 */
export type CpuDetailSampleV5 = {
  averageFrequencyMHz: number | null
  minimumFrequencyMHz: number | null
  maximumFrequencyMHz: number | null
  contextSwitchesPerSecond: number | null
  interruptsPerSecond: number | null
  forksPerSecond: number | null
  cpuIrqPercent: number | null
}

/**
 * Memory-subsystem detail: slab/dirty/writeback/commit breakdown from
 * `/proc/meminfo` plus reclaim/compaction rates from `/proc/vmstat`.
 * `pageScanDirectPerSecond`/`pageScanKswapdPerSecond` are kept separate
 * (rather than one combined scan total) because a direct-reclaim-heavy host
 * is under acute memory pressure in a way a kswapd-heavy host is not.
 */
export type MemoryDetailSampleV5 = {
  memoryFreeBytes: number | null
  cachedBytes: number | null
  anonPagesBytes: number | null
  slabReclaimableBytes: number | null
  slabUnreclaimableBytes: number | null
  dirtyBytes: number | null
  writebackBytes: number | null
  shmemBytes: number | null
  pageTablesBytes: number | null
  kernelStackBytes: number | null
  committedAsBytes: number | null
  commitLimitBytes: number | null
  activeAnonBytes: number | null
  inactiveAnonBytes: number | null
  activeFileBytes: number | null
  inactiveFileBytes: number | null
  pageScanDirectPerSecond: number | null
  pageScanKswapdPerSecond: number | null
  compactionStallsPerSecond: number | null
}

/**
 * Per-NUMA-node memory/allocation counters. Reserved conceptual family —
 * fully shaped, referenced only via `MetricsSampleV5.numaNodes?`, not yet
 * populated by any collector.
 */
export type NumaNodeSampleV5 = {
  nodeId: string
  freeBytes: number | null
  totalBytes: number | null
  localAllocationsPerSecond: number | null
  foreignAllocationsPerSecond: number | null
}

// ---------------------------------------------------------------------------
// Events — a closed catalog of discrete state-change/fault signals distinct
// from the continuous numeric metrics above.
// ---------------------------------------------------------------------------

export const METRIC_EVENT_KINDS_V5 = [
  'oom_kill',
  'hung_task',
  'conntrack_exhaustion',
  'fs_read_only',
  'fs_disappeared',
  'fs_remount',
  'smart_critical',
  'nvme_critical',
  'nvme_media_error',
  'raid_degraded',
  'raid_rebuild_started',
  'raid_rebuild_completed',
  'raid_rebuild_failed',
  'nic_link_down',
  'nic_link_up',
  'nic_flapping',
  'fabric_peer_change',
  'fabric_unavailable',
  'fabric_recovered',
  'fan_fault',
  'fan_alarm',
  'temp_alarm',
  'temp_critical',
  'psu_fault',
  'voltage_alarm',
  'edac_corrected',
  'edac_uncorrected',
  'gpu_xid',
  'gpu_ecc',
  'gpu_row_remap',
  'gpu_retirement',
  'gpu_fallen_off_bus',
  'gpu_thermal_critical',
  'gpu_disappeared',
  'clock_sync_lost',
  'clock_sync_restored',
  'topology_generation_changed',
  'boot_generation_changed',
] as const

export type MetricEventKindV5 = (typeof METRIC_EVENT_KINDS_V5)[number]

/**
 * Classifies every {@link MetricEventKindV5} as a physical-hardware-health
 * signal or not — the split `hardwareHealthEventsEnabled`
 * (`capability-plan.ts`) actually gates. `Record`, not an allowlist `Set`, so
 * adding a kind to {@link METRIC_EVENT_KINDS_V5} without extending this map
 * fails to compile instead of silently defaulting either way.
 *
 * Hardware-health (`true`): sensor/component-fault signals from a physical
 * part — disks (SMART/NVMe/RAID), NICs' physical link state, fans, thermal,
 * PSU/voltage, memory ECC, and GPU faults.
 *
 * Not hardware-health (`false`): OS/kernel conditions (`oom_kill`,
 * `hung_task`, `conntrack_exhaustion`), filesystem state changes
 * (`fs_read_only`, `fs_disappeared`, `fs_remount`), TurboFabric mesh overlay
 * state (`fabric_*`, gated separately by `turboFabricEnabled`), clock-sync
 * state, and topology/boot generation bumps — all operational history
 * unrelated to physical hardware that must survive a plan disabling
 * hardware-health events.
 */
export const HARDWARE_HEALTH_EVENT_KIND_V5: Record<MetricEventKindV5, boolean> = {
  oom_kill: false,
  hung_task: false,
  conntrack_exhaustion: false,
  fs_read_only: false,
  fs_disappeared: false,
  fs_remount: false,
  smart_critical: true,
  nvme_critical: true,
  nvme_media_error: true,
  raid_degraded: true,
  raid_rebuild_started: true,
  raid_rebuild_completed: true,
  raid_rebuild_failed: true,
  nic_link_down: true,
  nic_link_up: true,
  nic_flapping: true,
  fabric_peer_change: false,
  fabric_unavailable: false,
  fabric_recovered: false,
  fan_fault: true,
  fan_alarm: true,
  temp_alarm: true,
  temp_critical: true,
  psu_fault: true,
  voltage_alarm: true,
  edac_corrected: true,
  edac_uncorrected: true,
  gpu_xid: true,
  gpu_ecc: true,
  gpu_row_remap: true,
  gpu_retirement: true,
  gpu_fallen_off_bus: true,
  gpu_thermal_critical: true,
  gpu_disappeared: true,
  clock_sync_lost: false,
  clock_sync_restored: false,
  topology_generation_changed: false,
  boot_generation_changed: false,
}

/** Whether `kind` is a physical-hardware-health signal — see {@link HARDWARE_HEALTH_EVENT_KIND_V5}. */
export function isHardwareHealthEventKindV5(kind: MetricEventKindV5): boolean {
  return HARDWARE_HEALTH_EVENT_KIND_V5[kind]
}

export type MetricEventSeverityV5 = 'info' | 'warning' | 'critical'

export type MetricEventV5 = {
  eventId: string
  at: string
  kind: MetricEventKindV5
  severity: MetricEventSeverityV5
  entityId?: string
  source?: string
  payload?: Record<string, string | number | boolean | null>
}

/**
 * Module-load invariant: `METRIC_EVENT_KINDS_V5` — the array backing the
 * `MetricEventKindV5` union — has no duplicates. There is no
 * partition/ceiling to enforce here (unlike v3's `MetricPart`s); this is the
 * v5 analogue of `assertMetricPartsCoverAllKeys` scoped to what v5 actually
 * needs checked on import.
 */
function assertNoDuplicateEventKinds(): void {
  const seen = new Set<string>()
  for (const kind of METRIC_EVENT_KINDS_V5) {
    if (seen.has(kind)) {
      throw new TypeError(`duplicate MetricEventKindV5 entry: ${kind}`)
    }
    seen.add(kind)
  }
}
assertNoDuplicateEventKinds()

function assertValidEventKind(kind: string): asserts kind is MetricEventKindV5 {
  if (!(METRIC_EVENT_KINDS_V5 as readonly string[]).includes(kind)) {
    throw new TypeError(`metrics event has an unknown kind: ${kind}`)
  }
}

// ---------------------------------------------------------------------------
// Top-level sample
// ---------------------------------------------------------------------------

export type MetricsSampleMetadataV5 = {
  version: typeof METRICS_SCHEMA_VERSION_V5
  sampledAt: string
  intervalSeconds: number
  sequence: number
  collectionMode: MetricsCollectionModeV5
  topologyGeneration: number
  bootGeneration: number
}

export type MetricsSampleV5 = {
  type: 'metrics'
  metadata: MetricsSampleMetadataV5
  host: HostMetricsV5
  networks: NetworkDeviceSampleV5[]
  filesystems: FilesystemSampleV5[]
  blockDevices: BlockDeviceSampleV5[]
  gpus: GpuSampleV5[]
  hardwareSignals: HardwareSignalSampleV5[]
  ingressSources: IngressSourceSampleV5[]
  databaseProxies: DatabaseProxySampleV5[]
  events: MetricEventV5[]
  cpuDetail?: CpuDetailSampleV5
  memoryDetail?: MemoryDetailSampleV5
  numaNodes?: NumaNodeSampleV5[]
}

/**
 * Raw (pre-sanitize) constructor input. Every leaf metric field accepts
 * `number | null | undefined`; the constructor sanitizes/clamps and never
 * coerces a missing reading to `0`.
 */
export type MetricsSampleV5Input = {
  metadata: MetricsSampleMetadataV5
  host: {
    cpu: RawInput<HostCpuMetricsV5>
    kernel: RawInput<HostKernelMetricsV5>
    memory: RawInput<HostMemoryMetricsV5>
    storage: RawInput<HostStorageMetricsV5>
    network: RawInput<HostNetworkMetricsV5>
  }
  networks: RawInput<NetworkDeviceSampleV5>[]
  filesystems: RawInput<FilesystemSampleV5>[]
  blockDevices: RawInput<BlockDeviceSampleV5>[]
  gpus: RawInput<GpuSampleV5>[]
  hardwareSignals: RawInput<HardwareSignalSampleV5>[]
  ingressSources: RawInput<IngressSourceSampleV5>[]
  databaseProxies: RawInput<DatabaseProxySampleV5>[]
  events: MetricEventV5[]
  cpuDetail?: RawInput<CpuDetailSampleV5>
  memoryDetail?: RawInput<MemoryDetailSampleV5>
  numaNodes?: RawInput<NumaNodeSampleV5>[]
}

type RawInput<T> = {
  [K in keyof T]: T[K] extends string
    ? T[K]
    : T[K] extends (infer U)[]
      ? RawInput<U>[]
      : number | null | undefined
}

// ---------------------------------------------------------------------------
// Sanitization primitives — reused verbatim from v3's `contract.ts` idiom.
// Not imported from there: v5 has no dependency on the v3 module.
// ---------------------------------------------------------------------------

/** Clamp percent metrics to 0–100; pass through `null`. */
export function clampPercent(value: number | null): number | null {
  if (value === null) return null
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

/** Reject NaN/±Infinity → null; missing stays null (never coerced to 0). */
export function sanitizeFinite(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value)) return null
  return value
}

function assertFiniteNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`metrics ${field} must be a finite non-negative number`)
  }
}

function assertFinitePositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`metrics ${field} must be a finite positive number`)
  }
}

/**
 * Defensive cap on incoming entity array lengths. Real enforcement of
 * per-entity/per-family slot budgets lives in the later validation phase
 * (mirroring v3's `validateHostMetricsSample`); this constructor should not
 * accept unbounded input in the meantime.
 */
const MAX_METRIC_ENTITY_ARRAY_LENGTH = 64
const MAX_METRIC_EVENTS_PER_SAMPLE = 128

function assertArrayWithinCap(field: string, arr: readonly unknown[], cap: number): void {
  if (arr.length > cap) {
    throw new TypeError(
      `metrics ${field} has ${arr.length} entries, exceeding the ${cap}-entry cap`
    )
  }
}

function sanitizeHostCpu(raw: RawInput<HostCpuMetricsV5>): HostCpuMetricsV5 {
  return {
    busyPercent: clampPercent(sanitizeFinite(raw.busyPercent)),
    userPercent: clampPercent(sanitizeFinite(raw.userPercent)),
    systemPercent: clampPercent(sanitizeFinite(raw.systemPercent)),
    iowaitPercent: clampPercent(sanitizeFinite(raw.iowaitPercent)),
    stealPercent: clampPercent(sanitizeFinite(raw.stealPercent)),
    softirqPercent: clampPercent(sanitizeFinite(raw.softirqPercent)),
    pressureSomePercent: clampPercent(sanitizeFinite(raw.pressureSomePercent)),
    saturatedCoreCount: sanitizeFinite(raw.saturatedCoreCount),
    procsRunning: sanitizeFinite(raw.procsRunning),
    procsBlocked: sanitizeFinite(raw.procsBlocked),
    processCount: sanitizeFinite(raw.processCount),
  }
}

function sanitizeHostKernel(raw: RawInput<HostKernelMetricsV5>): HostKernelMetricsV5 {
  return {
    fileHandlesUsedPercent: clampPercent(sanitizeFinite(raw.fileHandlesUsedPercent)),
    conntrackUsedPercent: clampPercent(sanitizeFinite(raw.conntrackUsedPercent)),
  }
}

function sanitizeHostMemory(raw: RawInput<HostMemoryMetricsV5>): HostMemoryMetricsV5 {
  return {
    usedBytes: sanitizeFinite(raw.usedBytes),
    cachedFilesBytes: sanitizeFinite(raw.cachedFilesBytes),
    swapUsedBytes: sanitizeFinite(raw.swapUsedBytes),
    pressureSomePercent: clampPercent(sanitizeFinite(raw.pressureSomePercent)),
    pressureFullPercent: clampPercent(sanitizeFinite(raw.pressureFullPercent)),
    swapInBytesPerSecond: sanitizeFinite(raw.swapInBytesPerSecond),
    swapOutBytesPerSecond: sanitizeFinite(raw.swapOutBytesPerSecond),
    majorPageFaultsPerSecond: sanitizeFinite(raw.majorPageFaultsPerSecond),
  }
}

function sanitizeHostStorage(raw: RawInput<HostStorageMetricsV5>): HostStorageMetricsV5 {
  return {
    ioPressureSomePercent: clampPercent(sanitizeFinite(raw.ioPressureSomePercent)),
    ioPressureFullPercent: clampPercent(sanitizeFinite(raw.ioPressureFullPercent)),
    diskReadBytesPerSecond: sanitizeFinite(raw.diskReadBytesPerSecond),
    diskWriteBytesPerSecond: sanitizeFinite(raw.diskWriteBytesPerSecond),
    diskLatencyMs: sanitizeFinite(raw.diskLatencyMs),
    rootFilesystemAvailableBytes: sanitizeFinite(raw.rootFilesystemAvailableBytes),
    rootFilesystemFreeInodes: sanitizeFinite(raw.rootFilesystemFreeInodes),
  }
}

function sanitizeHostNetwork(raw: RawInput<HostNetworkMetricsV5>): HostNetworkMetricsV5 {
  return {
    tcpRetransmitPercent: clampPercent(sanitizeFinite(raw.tcpRetransmitPercent)),
    softnetDropsPerSecond: sanitizeFinite(raw.softnetDropsPerSecond),
  }
}

function sanitizeNetworkDevice(raw: RawInput<NetworkDeviceSampleV5>): NetworkDeviceSampleV5 {
  return {
    deviceId: raw.deviceId,
    receiveBytesPerSecond: sanitizeFinite(raw.receiveBytesPerSecond),
    transmitBytesPerSecond: sanitizeFinite(raw.transmitBytesPerSecond),
    receiveErrorsPerSecond: sanitizeFinite(raw.receiveErrorsPerSecond),
    transmitErrorsPerSecond: sanitizeFinite(raw.transmitErrorsPerSecond),
    receiveDropsPerSecond: sanitizeFinite(raw.receiveDropsPerSecond),
    transmitDropsPerSecond: sanitizeFinite(raw.transmitDropsPerSecond),
  }
}

function sanitizeFilesystem(raw: RawInput<FilesystemSampleV5>): FilesystemSampleV5 {
  return {
    filesystemId: raw.filesystemId,
    availableBytes: sanitizeFinite(raw.availableBytes),
    freeInodes: sanitizeFinite(raw.freeInodes),
  }
}

function sanitizeBlockDevice(raw: RawInput<BlockDeviceSampleV5>): BlockDeviceSampleV5 {
  return {
    deviceId: raw.deviceId,
    readBytesPerSecond: sanitizeFinite(raw.readBytesPerSecond),
    writeBytesPerSecond: sanitizeFinite(raw.writeBytesPerSecond),
    readOpsPerSecond: sanitizeFinite(raw.readOpsPerSecond),
    writeOpsPerSecond: sanitizeFinite(raw.writeOpsPerSecond),
    readLatencyMs: sanitizeFinite(raw.readLatencyMs),
    writeLatencyMs: sanitizeFinite(raw.writeLatencyMs),
    utilizationPercent: clampPercent(sanitizeFinite(raw.utilizationPercent)),
    temperatureCelsius: sanitizeFinite(raw.temperatureCelsius),
    queueDepth: sanitizeFinite(raw.queueDepth),
  }
}

function sanitizeGpu(raw: RawInput<GpuSampleV5>): GpuSampleV5 {
  return {
    gpuId: raw.gpuId,
    utilizationPercent: clampPercent(sanitizeFinite(raw.utilizationPercent)),
    memoryUsedBytes: sanitizeFinite(raw.memoryUsedBytes),
    memoryActivityPercent: clampPercent(sanitizeFinite(raw.memoryActivityPercent)),
    temperatureCelsius: sanitizeFinite(raw.temperatureCelsius),
    memoryTemperatureCelsius: sanitizeFinite(raw.memoryTemperatureCelsius),
    powerWatts: sanitizeFinite(raw.powerWatts),
    pcieReceiveBytesPerSecond: sanitizeFinite(raw.pcieReceiveBytesPerSecond),
    pcieTransmitBytesPerSecond: sanitizeFinite(raw.pcieTransmitBytesPerSecond),
    throttlePercent: clampPercent(sanitizeFinite(raw.throttlePercent)),
  }
}

function sanitizeHardwareSignal(raw: RawInput<HardwareSignalSampleV5>): HardwareSignalSampleV5 {
  return {
    signalId: raw.signalId,
    kind: raw.kind,
    value: sanitizeFinite(raw.value),
  }
}

function sanitizeIngressSource(raw: RawInput<IngressSourceSampleV5>): IngressSourceSampleV5 {
  return {
    sourceId: raw.sourceId,
    sourceKind: raw.sourceKind,
    requests: sanitizeFinite(raw.requests),
    responses2xx: sanitizeFinite(raw.responses2xx),
    responses3xx: sanitizeFinite(raw.responses3xx),
    responses4xx: sanitizeFinite(raw.responses4xx),
    responses5xx: sanitizeFinite(raw.responses5xx),
    requestErrors: sanitizeFinite(raw.requestErrors),
    requestBytes: sanitizeFinite(raw.requestBytes),
    responseBytes: sanitizeFinite(raw.responseBytes),
    requestDurationSecondsAvg: sanitizeFinite(raw.requestDurationSecondsAvg),
    requestsUnder100ms: sanitizeFinite(raw.requestsUnder100ms),
    requestsUnder500ms: sanitizeFinite(raw.requestsUnder500ms),
    requestsUnder1s: sanitizeFinite(raw.requestsUnder1s),
    requestsUnder5s: sanitizeFinite(raw.requestsUnder5s),
    requestsInFlight: sanitizeFinite(raw.requestsInFlight),
    upstreamsHealthy: sanitizeFinite(raw.upstreamsHealthy),
    upstreamsTotal: sanitizeFinite(raw.upstreamsTotal),
    retries: sanitizeFinite(raw.retries),
  }
}

function sanitizeDatabaseProxy(raw: RawInput<DatabaseProxySampleV5>): DatabaseProxySampleV5 {
  return {
    sourceId: raw.sourceId,
    sourceKind: raw.sourceKind,
    queries: sanitizeFinite(raw.queries),
    slowQueries: sanitizeFinite(raw.slowQueries),
    connectionErrors: sanitizeFinite(raw.connectionErrors),
    clientConnections: sanitizeFinite(raw.clientConnections),
    backendConnections: sanitizeFinite(raw.backendConnections),
    backendsUp: sanitizeFinite(raw.backendsUp),
  }
}

function sanitizeCpuDetail(raw: RawInput<CpuDetailSampleV5>): CpuDetailSampleV5 {
  return {
    averageFrequencyMHz: sanitizeFinite(raw.averageFrequencyMHz),
    minimumFrequencyMHz: sanitizeFinite(raw.minimumFrequencyMHz),
    maximumFrequencyMHz: sanitizeFinite(raw.maximumFrequencyMHz),
    contextSwitchesPerSecond: sanitizeFinite(raw.contextSwitchesPerSecond),
    interruptsPerSecond: sanitizeFinite(raw.interruptsPerSecond),
    forksPerSecond: sanitizeFinite(raw.forksPerSecond),
    cpuIrqPercent: clampPercent(sanitizeFinite(raw.cpuIrqPercent)),
  }
}

function sanitizeMemoryDetail(raw: RawInput<MemoryDetailSampleV5>): MemoryDetailSampleV5 {
  return {
    memoryFreeBytes: sanitizeFinite(raw.memoryFreeBytes),
    cachedBytes: sanitizeFinite(raw.cachedBytes),
    anonPagesBytes: sanitizeFinite(raw.anonPagesBytes),
    slabReclaimableBytes: sanitizeFinite(raw.slabReclaimableBytes),
    slabUnreclaimableBytes: sanitizeFinite(raw.slabUnreclaimableBytes),
    dirtyBytes: sanitizeFinite(raw.dirtyBytes),
    writebackBytes: sanitizeFinite(raw.writebackBytes),
    shmemBytes: sanitizeFinite(raw.shmemBytes),
    pageTablesBytes: sanitizeFinite(raw.pageTablesBytes),
    kernelStackBytes: sanitizeFinite(raw.kernelStackBytes),
    committedAsBytes: sanitizeFinite(raw.committedAsBytes),
    commitLimitBytes: sanitizeFinite(raw.commitLimitBytes),
    activeAnonBytes: sanitizeFinite(raw.activeAnonBytes),
    inactiveAnonBytes: sanitizeFinite(raw.inactiveAnonBytes),
    activeFileBytes: sanitizeFinite(raw.activeFileBytes),
    inactiveFileBytes: sanitizeFinite(raw.inactiveFileBytes),
    pageScanDirectPerSecond: sanitizeFinite(raw.pageScanDirectPerSecond),
    pageScanKswapdPerSecond: sanitizeFinite(raw.pageScanKswapdPerSecond),
    compactionStallsPerSecond: sanitizeFinite(raw.compactionStallsPerSecond),
  }
}

function sanitizeNumaNode(raw: RawInput<NumaNodeSampleV5>): NumaNodeSampleV5 {
  return {
    nodeId: raw.nodeId,
    freeBytes: sanitizeFinite(raw.freeBytes),
    totalBytes: sanitizeFinite(raw.totalBytes),
    localAllocationsPerSecond: sanitizeFinite(raw.localAllocationsPerSecond),
    foreignAllocationsPerSecond: sanitizeFinite(raw.foreignAllocationsPerSecond),
  }
}

function sanitizeEvent(event: MetricEventV5): MetricEventV5 {
  assertValidEventKind(event.kind)
  if (event.severity !== 'info' && event.severity !== 'warning' && event.severity !== 'critical') {
    throw new TypeError(`metrics event ${event.eventId} has an invalid severity: ${event.severity}`)
  }
  return event
}

export function buildMetricsSampleV5(input: MetricsSampleV5Input): MetricsSampleV5 {
  if (input.metadata.version !== METRICS_SCHEMA_VERSION_V5) {
    throw new TypeError(`metrics metadata.version must be ${METRICS_SCHEMA_VERSION_V5}`)
  }
  if (input.metadata.collectionMode !== 'baseline' && input.metadata.collectionMode !== 'live') {
    throw new TypeError('metrics metadata.collectionMode must be "baseline" or "live"')
  }
  // intervalSeconds is divisor-bearing downstream — zero is never valid.
  assertFinitePositive('metadata.intervalSeconds', input.metadata.intervalSeconds)
  assertFiniteNonNegative('metadata.sequence', input.metadata.sequence)
  assertFiniteNonNegative('metadata.topologyGeneration', input.metadata.topologyGeneration)
  assertFiniteNonNegative('metadata.bootGeneration', input.metadata.bootGeneration)

  assertArrayWithinCap('networks', input.networks, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('filesystems', input.filesystems, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('blockDevices', input.blockDevices, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('gpus', input.gpus, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('hardwareSignals', input.hardwareSignals, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('ingressSources', input.ingressSources, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('databaseProxies', input.databaseProxies, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  assertArrayWithinCap('events', input.events, MAX_METRIC_EVENTS_PER_SAMPLE)
  if (input.numaNodes) {
    assertArrayWithinCap('numaNodes', input.numaNodes, MAX_METRIC_ENTITY_ARRAY_LENGTH)
  }

  const sample: MetricsSampleV5 = {
    type: 'metrics',
    metadata: { ...input.metadata },
    host: {
      cpu: sanitizeHostCpu(input.host.cpu),
      kernel: sanitizeHostKernel(input.host.kernel),
      memory: sanitizeHostMemory(input.host.memory),
      storage: sanitizeHostStorage(input.host.storage),
      network: sanitizeHostNetwork(input.host.network),
    },
    networks: input.networks.map(sanitizeNetworkDevice),
    filesystems: input.filesystems.map(sanitizeFilesystem),
    blockDevices: input.blockDevices.map(sanitizeBlockDevice),
    gpus: input.gpus.map(sanitizeGpu),
    hardwareSignals: input.hardwareSignals.map(sanitizeHardwareSignal),
    ingressSources: input.ingressSources.map(sanitizeIngressSource),
    databaseProxies: input.databaseProxies.map(sanitizeDatabaseProxy),
    events: input.events.map(sanitizeEvent),
  }
  if (input.cpuDetail) sample.cpuDetail = sanitizeCpuDetail(input.cpuDetail)
  if (input.memoryDetail) {
    sample.memoryDetail = sanitizeMemoryDetail(input.memoryDetail)
  }
  if (input.numaNodes) {
    sample.numaNodes = input.numaNodes.map(sanitizeNumaNode)
  }
  return sample
}
