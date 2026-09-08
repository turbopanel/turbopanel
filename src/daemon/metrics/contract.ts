/**
 * Host metrics wire contract (daemon → instance). Mirrored in daemon
 * `src/metrics/contract.ts`.
 *
 * Metrics are grouped by entity (host, network device, filesystem, block
 * device, GPU, hardware signal, ingress source, database proxy, router,
 * managed storage, Docker usage)
 * instead of a flat key list, every leaf value is `number | null` (missing is always
 * `null`, never coerced to `0`), and entities carry a stable logical id
 * instead of relying on positional/part membership. Physical storage
 * layout (Cloudflare Analytics Engine packing) is entirely downstream of
 * this file — see `metric-descriptors.ts` (instance repo, control-plane
 * only) for the per-metric unit/aggregation/family contract this type
 * pairs with.
 *
 * Physical-only readings live on one family, not several: GPU
 * temperature/memory-temperature/power and service-drive temperature are
 * `HardwareSignalSample` entries keyed to the owning GPU/drive entity, not
 * fields on `GpuSample`/`BlockDeviceSample`. Those two entity types carry
 * workload telemetry only — a reading a VM can actually produce — so the
 * whole physical-sensor surface stays behind the one `isPhysicalMachine()`
 * gate that `hardware.physical` already applies.
 */

export const METRICS_SCHEMA_VERSION = 6 as const;

/** Maps every non-string field of `T` to `number | null` — the sanitized-output shape for a raw input `T`. */
type RawNumeric<T> = {
  [K in keyof T]: T[K] extends string ? T[K] : number | null;
};

// ---------------------------------------------------------------------------
// Host-scoped metrics (no entity id — one value per sample), grouped by
// subsystem. Together `cpu` + `kernel` + `memory` + `storage` + `network`
// cover the universal host.system/host.io metric families.
// ---------------------------------------------------------------------------

export type HostCpuMetrics = {
  busyPercent: number | null;
  userPercent: number | null;
  systemPercent: number | null;
  iowaitPercent: number | null;
  stealPercent: number | null;
  softirqPercent: number | null;
  pressureSomePercent: number | null;
  saturatedCoreCount: number | null;
  procsRunning: number | null;
  procsBlocked: number | null;
  /** Total `/proc` PID directories — not the run-queue `procs_running` gauge. */
  processCount: number | null;
};

export type HostKernelMetrics = {
  fileHandlesUsedPercent: number | null;
  conntrackUsedPercent: number | null;
};

export type HostMemoryMetrics = {
  usedBytes: number | null;
  cachedFilesBytes: number | null;
  swapUsedBytes: number | null;
  pressureSomePercent: number | null;
  pressureFullPercent: number | null;
  swapInBytesPerSecond: number | null;
  swapOutBytesPerSecond: number | null;
  majorPageFaultsPerSecond: number | null;
};

export type HostStorageMetrics = {
  ioPressureSomePercent: number | null;
  ioPressureFullPercent: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  diskLatencyMs: number | null;
  rootFilesystemAvailableBytes: number | null;
  rootFilesystemFreeInodes: number | null;
};

export type HostNetworkMetrics = {
  tcpRetransmitPercent: number | null;
  softnetDropsPerSecond: number | null;
};

export type HostMetrics = {
  cpu: HostCpuMetrics;
  kernel: HostKernelMetrics;
  memory: HostMemoryMetrics;
  storage: HostStorageMetrics;
  network: HostNetworkMetrics;
};

// ---------------------------------------------------------------------------
// Per-entity metrics. Every type's stable logical id comes first; every
// other field is `number | null` (or `string` for a kind/source
// discriminator).
// ---------------------------------------------------------------------------

export type NetworkDeviceSample = {
  deviceId: string;
  receiveBytesPerSecond: number | null;
  transmitBytesPerSecond: number | null;
  receiveErrorsPerSecond: number | null;
  transmitErrorsPerSecond: number | null;
  receiveDropsPerSecond: number | null;
  transmitDropsPerSecond: number | null;
};

export type FilesystemSample = {
  filesystemId: string;
  availableBytes: number | null;
  freeInodes: number | null;
};

export type BlockDeviceSample = {
  deviceId: string;
  readBytesPerSecond: number | null;
  writeBytesPerSecond: number | null;
  readOpsPerSecond: number | null;
  writeOpsPerSecond: number | null;
  readLatencyMs: number | null;
  writeLatencyMs: number | null;
  utilizationPercent: number | null;
  queueDepth: number | null;
};

export type GpuSample = {
  gpuId: string;
  utilizationPercent: number | null;
  memoryUsedBytes: number | null;
  memoryActivityPercent: number | null;
  pcieReceiveBytesPerSecond: number | null;
  pcieTransmitBytesPerSecond: number | null;
  throttlePercent: number | null;
};

/**
 * Conservative physical sensor reading (CPU package temp/power, storage
 * temp, trustworthy board temps, the synthetic hottest-core/thermal-throttled
 * CPU signals, plus the per-GPU temperature/memory-temperature/power and
 * per-service-drive temperature signals that used to ride `GpuSample`/
 * `BlockDeviceSample`) — dynamic count per host, not a fixed family. Never
 * fan RPM: fan tachometers have no home in sampled telemetry (fault/alarm
 * detection reads the live sensor candidate map directly instead).
 */
export type HardwareSignalSample = {
  signalId: string;
  kind: string;
  value: number | null;
};

/**
 * One HTTP ingress source's traffic telemetry. v6 narrowed this family to
 * Caddy alone — the shared-hosting Traefik router now reports its own
 * host-wide {@link RouterSample} instead of masquerading as a second
 * "ingress source" with a mostly-disjoint field set.
 *
 * Latency is carried as a raw per-interval **duration sum** plus six
 * cumulative-`le` bucket counters, never as a pre-computed average or
 * percentile. Averages and quantiles do not aggregate across time windows
 * (an average of averages is not the average, and a stored p99 cannot be
 * re-bucketed), so both are derived at read time from `requests` and the
 * buckets — see the instance repo's `query/derived-metrics.ts`.
 *
 * Bucket fields are cumulative in the Prometheus sense: `bucket50ms`
 * counts every request at or under 50ms (including those already counted by
 * `bucket10ms`), and `requests` is the implicit `+Inf` bucket.
 */
export type IngressSourceSample = {
  sourceId: string;
  /** Discriminates which ingress adapter produced this source (`"caddy"`). */
  sourceKind: string;
  requests: number | null;
  responses2xx: number | null;
  responses3xx: number | null;
  responses4xx: number | null;
  responses5xx: number | null;
  requestErrors: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  /** Raw per-interval sum of request durations, in seconds — never divided. */
  requestDurationSecondsSum: number | null;
  bucket10ms: number | null;
  bucket50ms: number | null;
  bucket100ms: number | null;
  bucket500ms: number | null;
  bucket1s: number | null;
  bucket5s: number | null;
  requestsInFlight: number | null;
  upstreamsHealthy: number | null;
  upstreamsTotal: number | null;
  retries: number | null;
};

/**
 * The shared-hosting HTTP router (Traefik) — host-wide and singleton, the
 * same shape family as {@link DiagnosticsSample} rather than a per-entity
 * array: a host runs exactly one shared ingress router, so there is no
 * `sourceId` to key on and the family carries no entity identity at all.
 *
 * v5 folded Traefik into `ingressSources[]` alongside Caddy, which forced
 * both onto one 17-field layout that fit neither: Traefik's
 * service/router/backend view has no Caddy analogue, and Caddy's
 * per-handler request accounting has no Traefik analogue. v6 splits them.
 *
 * Presence-gated the same way `diagnostics` is — absent entirely when no
 * router is reporting this tick, never an all-`null` placeholder.
 */
export type RouterSample = {
  backendsUp: number | null;
  backendsTotal: number | null;
  servicesTotal: number | null;
  routersTotal: number | null;
  retries: number | null;
  backendErrors5xx: number | null;
  backendLatencyMsAvg: number | null;
  backendRequests: number | null;
  httpOpenConnections: number | null;
  configReloads: number | null;
  configLastReloadAgeSeconds: number | null;
  tlsCertSoonestExpiryDays: number | null;
};

/**
 * One database-proxy source's telemetry. v6 widened this from the original
 * 6 fields to the 17 the ProxySQL exposition actually answers — connection
 * churn, rejection, byte flow and latency were all readable from the same
 * scrape the 6-field version already made.
 *
 * Both latency fields are per-interval means (total time delta ÷ query
 * delta), the only latency shape ProxySQL's counters support — it exposes
 * cumulative time totals, not histograms, so there are no buckets to derive
 * percentiles from the way `managed.ingress` has.
 */
export type DatabaseProxySample = {
  sourceId: string;
  /** Discriminates which database-proxy adapter produced this source (`"proxysql"`). */
  sourceKind: string;
  queries: number | null;
  slowQueries: number | null;
  queryLatencyMsAvg: number | null;
  backendLatencyMsAvg: number | null;
  activeTransactions: number | null;
  clientConnections: number | null;
  clientConnectionsCreated: number | null;
  clientConnectionsAborted: number | null;
  connectionsRejectedMaxConns: number | null;
  backendConnections: number | null;
  backendConnectionsCreated: number | null;
  backendConnectionsAborted: number | null;
  connectionErrors: number | null;
  backendsUp: number | null;
  backendsTotal: number | null;
  bytesFromBackends: number | null;
  bytesToBackends: number | null;
};

/**
 * Host diagnostics — the merged always-on depth family (v6). CPU
 * frequency/scheduling counters from `/proc/stat` + cpufreq, and the
 * memory-subsystem slab/dirty/writeback/commit breakdown from
 * `/proc/meminfo` plus reclaim/compaction rates from `/proc/vmstat`.
 *
 * v5 carried these as two separately capability-gated families
 * (`cpuDetail`/`memoryDetail`). v6 merges them into one ungated family —
 * doubles inside an Analytics Engine row are free, so depth costs nothing
 * once the row is written, and gating it only produced hosts whose
 * diagnostics panels were permanently blank.
 *
 * v6 also drops seven `/proc/meminfo` gauges that were never charted and are
 * derivable or near-static (`pageTablesBytes`, `kernelStackBytes`,
 * `commitLimitBytes`, and the four active/inactive anon/file gauges), which
 * is what lets the merged family fit one 19-slot AE row.
 *
 * `pageScanDirectPerSecond`/`pageScanKswapdPerSecond` stay separate (rather
 * than one combined scan total) because a direct-reclaim-heavy host is under
 * acute memory pressure in a way a kswapd-heavy host is not.
 */
export type DiagnosticsSample = {
  cpu: {
    averageFrequencyMHz: number | null;
    minimumFrequencyMHz: number | null;
    maximumFrequencyMHz: number | null;
    contextSwitchesPerSecond: number | null;
    interruptsPerSecond: number | null;
    forksPerSecond: number | null;
    cpuIrqPercent: number | null;
  };
  memory: {
    memoryFreeBytes: number | null;
    cachedBytes: number | null;
    anonPagesBytes: number | null;
    slabReclaimableBytes: number | null;
    slabUnreclaimableBytes: number | null;
    dirtyBytes: number | null;
    writebackBytes: number | null;
    shmemBytes: number | null;
    committedAsBytes: number | null;
    pageScanDirectPerSecond: number | null;
    pageScanKswapdPerSecond: number | null;
    compactionStallsPerSecond: number | null;
  };
};

/** `DiagnosticsSample`'s CPU half — the 7 host-wide frequency/scheduling scalars. */
export type DiagnosticsCpuSample = DiagnosticsSample["cpu"];

/** `DiagnosticsSample`'s memory half — the 12 meminfo/vmstat gauges and rates. */
export type DiagnosticsMemorySample = DiagnosticsSample["memory"];

/**
 * One managed-database engine's host-wide rollup inside {@link StorageSample}
 * — how many instances of that engine are running/healthy on this host and
 * how much of their aggregate connection budget is in use.
 *
 * Grouped per engine (rather than three flat `postgresInstancesRunning`-style
 * fields on `StorageSample`) because the engines are the same four readings
 * three times over, and a fourth engine later should be one more group, not
 * four more fields. Storage and the AE packer both flatten the group back to
 * `<engine><Field>` (`postgresInstancesRunning`), which is what keeps every
 * descriptor `canonicalName` and DuckDB column name unique.
 *
 * Collected by the daemon's managed-engine census (`collector/managed-engines.ts`):
 * instances are the containers labelled with the engine code, `healthy`
 * counts those answering the engine's own readiness probe, and the
 * connection pair sums each instance's client count against its
 * `max_connections`. An engine with no instance on the host keeps all four
 * `null`, and so does every engine before the first census lands — a host
 * with no Postgres and a host whose census has not been read yet are both
 * "unknown", never `0`; an engine with instances present reports real
 * counts, including `0` running.
 */
export type StorageEngineSample = {
  instancesRunning: number | null;
  instancesHealthy: number | null;
  connectionsUsed: number | null;
  connectionsMax: number | null;
};

/**
 * Host-wide managed-storage accounting — where the host's bytes actually
 * went, plus the managed-database census that explains why. Host-wide and
 * singleton, the same shape family as {@link DiagnosticsSample} and
 * {@link RouterSample} rather than a per-entity array: there is exactly one
 * hosting root, one backup root, one Docker data root and one log directory
 * per host, so the family carries no entity identity at all.
 *
 * Distinct from `HostStorageMetrics` (the `host.storage` group), which is
 * block-layer I/O plus root-filesystem capacity. This family answers "what is
 * consuming the disk" — a product question — where `host.storage` answers
 * "how is the disk behaving".
 *
 * The four `*UsedBytes` fields are **directory** usage, not filesystem usage:
 * a hosting root that is not its own mount point costs a bounded recursive
 * walk, which is why the daemon computes them on their own slow interval and
 * the sample tick only reads the cached result (see the daemon's
 * `collector/directory-usage.ts`). The three `*FreeBytes` fields are the
 * containing filesystem's free space, so a used/free pair on the same row
 * answers "can this grow" without a join.
 *
 * `dockerUsedBytes` is the one field this family shares with
 * {@link DockerUsageSample}: it is the total that breakdown sums to, kept
 * here so a storage panel needs one row rather than two.
 *
 * Presence-gated the same way `diagnostics`/`router` are — absent entirely
 * until the walker's first result lands, never an all-`null` placeholder.
 *
 * 19 fields exactly (7 + 3 × 4), filling one AE page with no spares.
 */
export type StorageSample = {
  hostingUsedBytes: number | null;
  backupUsedBytes: number | null;
  dockerUsedBytes: number | null;
  logsUsedBytes: number | null;
  hostingFreeBytes: number | null;
  backupFreeBytes: number | null;
  logsFreeBytes: number | null;
  postgres: StorageEngineSample;
  mysql: StorageEngineSample;
  mariadb: StorageEngineSample;
};

/** `StorageSample`'s per-engine group keys, in declared (physical slot) order. */
export const STORAGE_ENGINE_KEYS = ["postgres", "mysql", "mariadb"] as const;

export type StorageEngineKey = (typeof STORAGE_ENGINE_KEYS)[number];

/** `StorageEngineSample`'s four field names, in declared (physical slot) order. */
export const STORAGE_ENGINE_FIELD_NAMES = [
  "instancesRunning",
  "instancesHealthy",
  "connectionsUsed",
  "connectionsMax",
] as const;

/** `StorageSample`'s seven flat (non-engine) field names, in declared order. */
export const STORAGE_FLAT_FIELD_NAMES = [
  "hostingUsedBytes",
  "backupUsedBytes",
  "dockerUsedBytes",
  "logsUsedBytes",
  "hostingFreeBytes",
  "backupFreeBytes",
  "logsFreeBytes",
] as const;

/**
 * Flattened `<engine><Field>` name for one per-engine reading —
 * `("postgres", "instancesRunning")` → `"postgresInstancesRunning"`. The one
 * place the flattening rule lives: descriptors, the AE field order, the
 * DuckDB column names and the wire validator all derive from it rather than
 * restating twelve literals apiece.
 */
export function storageEngineFieldName(
  engine: StorageEngineKey,
  field: (typeof STORAGE_ENGINE_FIELD_NAMES)[number],
): string {
  return `${engine}${field[0].toUpperCase()}${field.slice(1)}`;
}

/**
 * Docker's own disk breakdown — the `GET /system/df` reduction, host-wide and
 * singleton like {@link StorageSample}.
 *
 * Split out of `StorageSample` rather than folded into it because the two
 * families are bought differently: storage accounting is granted at every
 * tier (a host always knows where its bytes went), while the Docker breakdown
 * is a managed-container feature the capability plan's `managedDockerEnabled`
 * gates. Ten fields on a 19-slot page, so the remaining nine slots stay
 * reserved spares for the per-image/per-volume depth a later phase adds.
 *
 * Every `*ReclaimableBytes` field is the subset of its group Docker would
 * free on a prune — images with no container, volumes with no reference,
 * build-cache entries not in use — never a projection of what could be freed
 * by deleting live objects.
 *
 * Presence-gated: absent entirely when the Docker socket is unavailable or
 * the periodic `/system/df` read has not landed yet.
 */
export type DockerUsageSample = {
  layersBytes: number | null;
  imagesCount: number | null;
  imagesReclaimableBytes: number | null;
  containersBytes: number | null;
  containersCount: number | null;
  volumesBytes: number | null;
  volumesCount: number | null;
  volumesReclaimableBytes: number | null;
  buildCacheBytes: number | null;
  buildCacheReclaimableBytes: number | null;
};

// ---------------------------------------------------------------------------
// Events — a closed catalog of discrete state-change/fault signals distinct
// from the continuous numeric metrics above.
// ---------------------------------------------------------------------------

export const METRIC_EVENT_KINDS = [
  "oom_kill",
  "hung_task",
  "conntrack_exhaustion",
  "fs_read_only",
  "fs_disappeared",
  "fs_remount",
  "smart_critical",
  "nvme_critical",
  "nvme_media_error",
  "raid_degraded",
  "raid_rebuild_started",
  "raid_rebuild_completed",
  "raid_rebuild_failed",
  "nic_link_down",
  "nic_link_up",
  "nic_flapping",
  "fabric_peer_change",
  "fabric_unavailable",
  "fabric_recovered",
  "fan_fault",
  "fan_alarm",
  "temp_alarm",
  "temp_critical",
  "psu_fault",
  "voltage_alarm",
  "edac_corrected",
  "edac_uncorrected",
  "gpu_xid",
  "gpu_ecc",
  "gpu_row_remap",
  "gpu_retirement",
  "gpu_fallen_off_bus",
  "gpu_thermal_critical",
  "gpu_disappeared",
  "clock_sync_lost",
  "clock_sync_restored",
  "topology_generation_changed",
  "boot_generation_changed",
] as const;

export type MetricEventKind = (typeof METRIC_EVENT_KINDS)[number];

/**
 * Classifies every {@link MetricEventKind} as a physical-hardware-health
 * signal or not — the split `hardwareHealthEventsEnabled`
 * (`capability-plan.ts`) actually gates. `Record`, not an allowlist `Set`, so
 * adding a kind to {@link METRIC_EVENT_KINDS} without extending this map
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
export const HARDWARE_HEALTH_EVENT_KIND: Record<MetricEventKind, boolean> = {
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
};

/** Whether `kind` is a physical-hardware-health signal — see {@link HARDWARE_HEALTH_EVENT_KIND}. */
export function isHardwareHealthEventKind(kind: MetricEventKind): boolean {
  return HARDWARE_HEALTH_EVENT_KIND[kind];
}

export type MetricEventSeverity = "info" | "warning" | "critical";

export type MetricEvent = {
  eventId: string;
  at: string;
  kind: MetricEventKind;
  severity: MetricEventSeverity;
  entityId?: string;
  source?: string;
  payload?: Record<string, string | number | boolean | null>;
};

/**
 * Module-load invariant: `METRIC_EVENT_KINDS` — the array backing the
 * `MetricEventKind` union — has no duplicates. There is no
 * partition/ceiling to enforce here (unlike v3's `MetricPart`s); this is the
 * v5 analogue of `assertMetricPartsCoverAllKeys` scoped to what v5 actually
 * needs checked on import.
 */
function assertNoDuplicateEventKinds(): void {
  const seen = new Set<string>();
  for (const kind of METRIC_EVENT_KINDS) {
    if (seen.has(kind)) {
      throw new TypeError(`duplicate MetricEventKind entry: ${kind}`);
    }
    seen.add(kind);
  }
}
assertNoDuplicateEventKinds();

function assertValidEventKind(kind: string): asserts kind is MetricEventKind {
  if (!(METRIC_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`metrics event has an unknown kind: ${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Top-level sample
// ---------------------------------------------------------------------------

export type MetricsSampleMetadata = {
  version: typeof METRICS_SCHEMA_VERSION;
  sampledAt: string;
  intervalSeconds: number;
  sequence: number;
  topologyGeneration: number;
  bootGeneration: number;
};

export type MetricsSample = {
  type: "metrics";
  metadata: MetricsSampleMetadata;
  host: HostMetrics;
  networks: NetworkDeviceSample[];
  filesystems: FilesystemSample[];
  blockDevices: BlockDeviceSample[];
  gpus: GpuSample[];
  hardwareSignals: HardwareSignalSample[];
  ingressSources: IngressSourceSample[];
  databaseProxies: DatabaseProxySample[];
  events: MetricEvent[];
  diagnostics?: DiagnosticsSample;
  router?: RouterSample;
  storage?: StorageSample;
  dockerUsage?: DockerUsageSample;
};

/**
 * Raw (pre-sanitize) constructor input. Every leaf metric field accepts
 * `number | null | undefined`; the constructor sanitizes/clamps and never
 * coerces a missing reading to `0`.
 */
export type MetricsSampleInput = {
  metadata: MetricsSampleMetadata;
  host: {
    cpu: RawInput<HostCpuMetrics>;
    kernel: RawInput<HostKernelMetrics>;
    memory: RawInput<HostMemoryMetrics>;
    storage: RawInput<HostStorageMetrics>;
    network: RawInput<HostNetworkMetrics>;
  };
  networks: RawInput<NetworkDeviceSample>[];
  filesystems: RawInput<FilesystemSample>[];
  blockDevices: RawInput<BlockDeviceSample>[];
  gpus: RawInput<GpuSample>[];
  hardwareSignals: RawInput<HardwareSignalSample>[];
  ingressSources: RawInput<IngressSourceSample>[];
  databaseProxies: RawInput<DatabaseProxySample>[];
  events: MetricEvent[];
  diagnostics?: RawInput<DiagnosticsSample>;
  router?: RawInput<RouterSample>;
  storage?: RawInput<StorageSample>;
  dockerUsage?: RawInput<DockerUsageSample>;
};

type RawInput<T> = {
  [K in keyof T]: T[K] extends string ? T[K]
    : T[K] extends (infer U)[] ? RawInput<U>[]
    : T[K] extends object ? RawInput<T[K]>
    : number | null | undefined;
};

// ---------------------------------------------------------------------------
// Sanitization primitives — reused verbatim from v3's `contract.ts` idiom.
// Not imported from there: v5 has no dependency on the v3 module.
// ---------------------------------------------------------------------------

/** Clamp percent metrics to 0–100; pass through `null`. */
export function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Reject NaN/±Infinity → null; missing stays null (never coerced to 0). */
export function sanitizeFinite(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function assertFiniteNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `metrics ${field} must be a finite non-negative number`,
    );
  }
}

function assertFinitePositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `metrics ${field} must be a finite positive number`,
    );
  }
}

/**
 * Defensive cap on incoming entity array lengths. Real enforcement of
 * per-entity/per-family slot budgets lives in the later validation phase
 * (mirroring v3's `validateHostMetricsSample`); this constructor should not
 * accept unbounded input in the meantime.
 */
const MAX_METRIC_ENTITY_ARRAY_LENGTH = 64;
const MAX_METRIC_EVENTS_PER_SAMPLE = 128;

function assertArrayWithinCap(
  field: string,
  arr: readonly unknown[],
  cap: number,
): void {
  if (arr.length > cap) {
    throw new TypeError(
      `metrics ${field} has ${arr.length} entries, exceeding the ${cap}-entry cap`,
    );
  }
}

function sanitizeHostCpu(raw: RawInput<HostCpuMetrics>): HostCpuMetrics {
  return {
    busyPercent: clampPercent(sanitizeFinite(raw.busyPercent)),
    userPercent: clampPercent(sanitizeFinite(raw.userPercent)),
    systemPercent: clampPercent(sanitizeFinite(raw.systemPercent)),
    iowaitPercent: clampPercent(sanitizeFinite(raw.iowaitPercent)),
    stealPercent: clampPercent(sanitizeFinite(raw.stealPercent)),
    softirqPercent: clampPercent(sanitizeFinite(raw.softirqPercent)),
    pressureSomePercent: clampPercent(
      sanitizeFinite(raw.pressureSomePercent),
    ),
    saturatedCoreCount: sanitizeFinite(raw.saturatedCoreCount),
    procsRunning: sanitizeFinite(raw.procsRunning),
    procsBlocked: sanitizeFinite(raw.procsBlocked),
    processCount: sanitizeFinite(raw.processCount),
  };
}

function sanitizeHostKernel(
  raw: RawInput<HostKernelMetrics>,
): HostKernelMetrics {
  return {
    fileHandlesUsedPercent: clampPercent(
      sanitizeFinite(raw.fileHandlesUsedPercent),
    ),
    conntrackUsedPercent: clampPercent(
      sanitizeFinite(raw.conntrackUsedPercent),
    ),
  };
}

function sanitizeHostMemory(
  raw: RawInput<HostMemoryMetrics>,
): HostMemoryMetrics {
  return {
    usedBytes: sanitizeFinite(raw.usedBytes),
    cachedFilesBytes: sanitizeFinite(raw.cachedFilesBytes),
    swapUsedBytes: sanitizeFinite(raw.swapUsedBytes),
    pressureSomePercent: clampPercent(
      sanitizeFinite(raw.pressureSomePercent),
    ),
    pressureFullPercent: clampPercent(
      sanitizeFinite(raw.pressureFullPercent),
    ),
    swapInBytesPerSecond: sanitizeFinite(raw.swapInBytesPerSecond),
    swapOutBytesPerSecond: sanitizeFinite(raw.swapOutBytesPerSecond),
    majorPageFaultsPerSecond: sanitizeFinite(raw.majorPageFaultsPerSecond),
  };
}

function sanitizeHostStorage(
  raw: RawInput<HostStorageMetrics>,
): HostStorageMetrics {
  return {
    ioPressureSomePercent: clampPercent(
      sanitizeFinite(raw.ioPressureSomePercent),
    ),
    ioPressureFullPercent: clampPercent(
      sanitizeFinite(raw.ioPressureFullPercent),
    ),
    diskReadBytesPerSecond: sanitizeFinite(raw.diskReadBytesPerSecond),
    diskWriteBytesPerSecond: sanitizeFinite(raw.diskWriteBytesPerSecond),
    diskLatencyMs: sanitizeFinite(raw.diskLatencyMs),
    rootFilesystemAvailableBytes: sanitizeFinite(
      raw.rootFilesystemAvailableBytes,
    ),
    rootFilesystemFreeInodes: sanitizeFinite(raw.rootFilesystemFreeInodes),
  };
}

function sanitizeHostNetwork(
  raw: RawInput<HostNetworkMetrics>,
): HostNetworkMetrics {
  return {
    tcpRetransmitPercent: clampPercent(
      sanitizeFinite(raw.tcpRetransmitPercent),
    ),
    softnetDropsPerSecond: sanitizeFinite(raw.softnetDropsPerSecond),
  };
}

function sanitizeNetworkDevice(
  raw: RawInput<NetworkDeviceSample>,
): NetworkDeviceSample {
  return {
    deviceId: raw.deviceId,
    receiveBytesPerSecond: sanitizeFinite(raw.receiveBytesPerSecond),
    transmitBytesPerSecond: sanitizeFinite(raw.transmitBytesPerSecond),
    receiveErrorsPerSecond: sanitizeFinite(raw.receiveErrorsPerSecond),
    transmitErrorsPerSecond: sanitizeFinite(raw.transmitErrorsPerSecond),
    receiveDropsPerSecond: sanitizeFinite(raw.receiveDropsPerSecond),
    transmitDropsPerSecond: sanitizeFinite(raw.transmitDropsPerSecond),
  };
}

function sanitizeFilesystem(
  raw: RawInput<FilesystemSample>,
): FilesystemSample {
  return {
    filesystemId: raw.filesystemId,
    availableBytes: sanitizeFinite(raw.availableBytes),
    freeInodes: sanitizeFinite(raw.freeInodes),
  };
}

function sanitizeBlockDevice(
  raw: RawInput<BlockDeviceSample>,
): BlockDeviceSample {
  return {
    deviceId: raw.deviceId,
    readBytesPerSecond: sanitizeFinite(raw.readBytesPerSecond),
    writeBytesPerSecond: sanitizeFinite(raw.writeBytesPerSecond),
    readOpsPerSecond: sanitizeFinite(raw.readOpsPerSecond),
    writeOpsPerSecond: sanitizeFinite(raw.writeOpsPerSecond),
    readLatencyMs: sanitizeFinite(raw.readLatencyMs),
    writeLatencyMs: sanitizeFinite(raw.writeLatencyMs),
    utilizationPercent: clampPercent(sanitizeFinite(raw.utilizationPercent)),
    queueDepth: sanitizeFinite(raw.queueDepth),
  };
}

function sanitizeGpu(raw: RawInput<GpuSample>): GpuSample {
  return {
    gpuId: raw.gpuId,
    utilizationPercent: clampPercent(sanitizeFinite(raw.utilizationPercent)),
    memoryUsedBytes: sanitizeFinite(raw.memoryUsedBytes),
    memoryActivityPercent: clampPercent(
      sanitizeFinite(raw.memoryActivityPercent),
    ),
    pcieReceiveBytesPerSecond: sanitizeFinite(raw.pcieReceiveBytesPerSecond),
    pcieTransmitBytesPerSecond: sanitizeFinite(
      raw.pcieTransmitBytesPerSecond,
    ),
    throttlePercent: clampPercent(sanitizeFinite(raw.throttlePercent)),
  };
}

function sanitizeHardwareSignal(
  raw: RawInput<HardwareSignalSample>,
): HardwareSignalSample {
  return {
    signalId: raw.signalId,
    kind: raw.kind,
    value: sanitizeFinite(raw.value),
  };
}

function sanitizeIngressSource(
  raw: RawInput<IngressSourceSample>,
): IngressSourceSample {
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
    requestDurationSecondsSum: sanitizeFinite(raw.requestDurationSecondsSum),
    bucket10ms: sanitizeFinite(raw.bucket10ms),
    bucket50ms: sanitizeFinite(raw.bucket50ms),
    bucket100ms: sanitizeFinite(raw.bucket100ms),
    bucket500ms: sanitizeFinite(raw.bucket500ms),
    bucket1s: sanitizeFinite(raw.bucket1s),
    bucket5s: sanitizeFinite(raw.bucket5s),
    requestsInFlight: sanitizeFinite(raw.requestsInFlight),
    upstreamsHealthy: sanitizeFinite(raw.upstreamsHealthy),
    upstreamsTotal: sanitizeFinite(raw.upstreamsTotal),
    retries: sanitizeFinite(raw.retries),
  };
}

function sanitizeDatabaseProxy(
  raw: RawInput<DatabaseProxySample>,
): DatabaseProxySample {
  return {
    sourceId: raw.sourceId,
    sourceKind: raw.sourceKind,
    queries: sanitizeFinite(raw.queries),
    slowQueries: sanitizeFinite(raw.slowQueries),
    queryLatencyMsAvg: sanitizeFinite(raw.queryLatencyMsAvg),
    backendLatencyMsAvg: sanitizeFinite(raw.backendLatencyMsAvg),
    activeTransactions: sanitizeFinite(raw.activeTransactions),
    clientConnections: sanitizeFinite(raw.clientConnections),
    clientConnectionsCreated: sanitizeFinite(raw.clientConnectionsCreated),
    clientConnectionsAborted: sanitizeFinite(raw.clientConnectionsAborted),
    connectionsRejectedMaxConns: sanitizeFinite(
      raw.connectionsRejectedMaxConns,
    ),
    backendConnections: sanitizeFinite(raw.backendConnections),
    backendConnectionsCreated: sanitizeFinite(raw.backendConnectionsCreated),
    backendConnectionsAborted: sanitizeFinite(raw.backendConnectionsAborted),
    connectionErrors: sanitizeFinite(raw.connectionErrors),
    backendsUp: sanitizeFinite(raw.backendsUp),
    backendsTotal: sanitizeFinite(raw.backendsTotal),
    bytesFromBackends: sanitizeFinite(raw.bytesFromBackends),
    bytesToBackends: sanitizeFinite(raw.bytesToBackends),
  };
}

function sanitizeRouter(raw: RawInput<RouterSample>): RouterSample {
  return {
    backendsUp: sanitizeFinite(raw.backendsUp),
    backendsTotal: sanitizeFinite(raw.backendsTotal),
    servicesTotal: sanitizeFinite(raw.servicesTotal),
    routersTotal: sanitizeFinite(raw.routersTotal),
    retries: sanitizeFinite(raw.retries),
    backendErrors5xx: sanitizeFinite(raw.backendErrors5xx),
    backendLatencyMsAvg: sanitizeFinite(raw.backendLatencyMsAvg),
    backendRequests: sanitizeFinite(raw.backendRequests),
    httpOpenConnections: sanitizeFinite(raw.httpOpenConnections),
    configReloads: sanitizeFinite(raw.configReloads),
    configLastReloadAgeSeconds: sanitizeFinite(
      raw.configLastReloadAgeSeconds,
    ),
    tlsCertSoonestExpiryDays: sanitizeFinite(raw.tlsCertSoonestExpiryDays),
  };
}

function sanitizeDiagnostics(
  raw: RawInput<DiagnosticsSample>,
): DiagnosticsSample {
  return {
    cpu: {
      averageFrequencyMHz: sanitizeFinite(raw.cpu.averageFrequencyMHz),
      minimumFrequencyMHz: sanitizeFinite(raw.cpu.minimumFrequencyMHz),
      maximumFrequencyMHz: sanitizeFinite(raw.cpu.maximumFrequencyMHz),
      contextSwitchesPerSecond: sanitizeFinite(
        raw.cpu.contextSwitchesPerSecond,
      ),
      interruptsPerSecond: sanitizeFinite(raw.cpu.interruptsPerSecond),
      forksPerSecond: sanitizeFinite(raw.cpu.forksPerSecond),
      cpuIrqPercent: clampPercent(sanitizeFinite(raw.cpu.cpuIrqPercent)),
    },
    memory: {
      memoryFreeBytes: sanitizeFinite(raw.memory.memoryFreeBytes),
      cachedBytes: sanitizeFinite(raw.memory.cachedBytes),
      anonPagesBytes: sanitizeFinite(raw.memory.anonPagesBytes),
      slabReclaimableBytes: sanitizeFinite(raw.memory.slabReclaimableBytes),
      slabUnreclaimableBytes: sanitizeFinite(raw.memory.slabUnreclaimableBytes),
      dirtyBytes: sanitizeFinite(raw.memory.dirtyBytes),
      writebackBytes: sanitizeFinite(raw.memory.writebackBytes),
      shmemBytes: sanitizeFinite(raw.memory.shmemBytes),
      committedAsBytes: sanitizeFinite(raw.memory.committedAsBytes),
      pageScanDirectPerSecond: sanitizeFinite(
        raw.memory.pageScanDirectPerSecond,
      ),
      pageScanKswapdPerSecond: sanitizeFinite(
        raw.memory.pageScanKswapdPerSecond,
      ),
      compactionStallsPerSecond: sanitizeFinite(
        raw.memory.compactionStallsPerSecond,
      ),
    },
  };
}

function sanitizeStorageEngine(
  raw: RawInput<StorageEngineSample>,
): StorageEngineSample {
  return {
    instancesRunning: sanitizeFinite(raw.instancesRunning),
    instancesHealthy: sanitizeFinite(raw.instancesHealthy),
    connectionsUsed: sanitizeFinite(raw.connectionsUsed),
    connectionsMax: sanitizeFinite(raw.connectionsMax),
  };
}

function sanitizeStorage(raw: RawInput<StorageSample>): StorageSample {
  return {
    hostingUsedBytes: sanitizeFinite(raw.hostingUsedBytes),
    backupUsedBytes: sanitizeFinite(raw.backupUsedBytes),
    dockerUsedBytes: sanitizeFinite(raw.dockerUsedBytes),
    logsUsedBytes: sanitizeFinite(raw.logsUsedBytes),
    hostingFreeBytes: sanitizeFinite(raw.hostingFreeBytes),
    backupFreeBytes: sanitizeFinite(raw.backupFreeBytes),
    logsFreeBytes: sanitizeFinite(raw.logsFreeBytes),
    postgres: sanitizeStorageEngine(raw.postgres),
    mysql: sanitizeStorageEngine(raw.mysql),
    mariadb: sanitizeStorageEngine(raw.mariadb),
  };
}

function sanitizeDockerUsage(
  raw: RawInput<DockerUsageSample>,
): DockerUsageSample {
  return {
    layersBytes: sanitizeFinite(raw.layersBytes),
    imagesCount: sanitizeFinite(raw.imagesCount),
    imagesReclaimableBytes: sanitizeFinite(raw.imagesReclaimableBytes),
    containersBytes: sanitizeFinite(raw.containersBytes),
    containersCount: sanitizeFinite(raw.containersCount),
    volumesBytes: sanitizeFinite(raw.volumesBytes),
    volumesCount: sanitizeFinite(raw.volumesCount),
    volumesReclaimableBytes: sanitizeFinite(raw.volumesReclaimableBytes),
    buildCacheBytes: sanitizeFinite(raw.buildCacheBytes),
    buildCacheReclaimableBytes: sanitizeFinite(raw.buildCacheReclaimableBytes),
  };
}

function sanitizeEvent(event: MetricEvent): MetricEvent {
  assertValidEventKind(event.kind);
  if (
    event.severity !== "info" &&
    event.severity !== "warning" &&
    event.severity !== "critical"
  ) {
    throw new TypeError(
      `metrics event ${event.eventId} has an invalid severity: ${event.severity}`,
    );
  }
  return event;
}

export function buildMetricsSample(
  input: MetricsSampleInput,
): MetricsSample {
  if (input.metadata.version !== METRICS_SCHEMA_VERSION) {
    throw new TypeError(
      `metrics metadata.version must be ${METRICS_SCHEMA_VERSION}`,
    );
  }
  // intervalSeconds is divisor-bearing downstream — zero is never valid.
  assertFinitePositive(
    "metadata.intervalSeconds",
    input.metadata.intervalSeconds,
  );
  assertFiniteNonNegative("metadata.sequence", input.metadata.sequence);
  assertFiniteNonNegative(
    "metadata.topologyGeneration",
    input.metadata.topologyGeneration,
  );
  assertFiniteNonNegative(
    "metadata.bootGeneration",
    input.metadata.bootGeneration,
  );

  assertArrayWithinCap(
    "networks",
    input.networks,
    MAX_METRIC_ENTITY_ARRAY_LENGTH,
  );
  assertArrayWithinCap(
    "filesystems",
    input.filesystems,
    MAX_METRIC_ENTITY_ARRAY_LENGTH,
  );
  assertArrayWithinCap(
    "blockDevices",
    input.blockDevices,
    MAX_METRIC_ENTITY_ARRAY_LENGTH,
  );
  assertArrayWithinCap("gpus", input.gpus, MAX_METRIC_ENTITY_ARRAY_LENGTH);
  assertArrayWithinCap(
    "hardwareSignals",
    input.hardwareSignals,
    MAX_METRIC_ENTITY_ARRAY_LENGTH,
  );
  assertArrayWithinCap(
    "ingressSources",
    input.ingressSources,
    MAX_METRIC_ENTITY_ARRAY_LENGTH,
  );
  assertArrayWithinCap(
    "databaseProxies",
    input.databaseProxies,
    MAX_METRIC_ENTITY_ARRAY_LENGTH,
  );
  assertArrayWithinCap("events", input.events, MAX_METRIC_EVENTS_PER_SAMPLE);

  const sample: MetricsSample = {
    type: "metrics",
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
  };
  if (input.diagnostics) {
    sample.diagnostics = sanitizeDiagnostics(input.diagnostics);
  }
  if (input.router) {
    sample.router = sanitizeRouter(input.router);
  }
  if (input.storage) {
    sample.storage = sanitizeStorage(input.storage);
  }
  if (input.dockerUsage) {
    sample.dockerUsage = sanitizeDockerUsage(input.dockerUsage);
  }
  return sample;
}
