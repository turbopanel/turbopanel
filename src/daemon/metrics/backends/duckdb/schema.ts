/**
 * DuckDB metrics schema DDL for the v5 contract — the DuckDB backend's own
 * private field map, independent of `../cloudflare/field-map.ts`'s AE
 * positional layout.
 *
 * v5 replaces v3's single wide `server_metric_samples` table with one table
 * per entity family (host, network, filesystem, block, GPU, hardware signal,
 * ingress, database proxy) plus a discrete events table, mirroring
 * `contract.ts`'s per-entity grouping. Every metric column is a real
 * nullable `DOUBLE` with a real SQL `NULL` for "missing" — no positional
 * `doubleN`/`blobN` slots, no missing-metric sentinel, and (unlike v3) no
 * `parts` marker column: v5 has no `MetricPart` allowlist, so a family's
 * table simply has no row for a sample that never reported that family.
 *
 * `diagnostics` is v6's single merged depth family, replacing v5's two
 * separately capability-gated `cpuDetail`/`memoryDetail` families. It is
 * still stored in two places for query-shape reasons: its 7 CPU scalars are
 * hand-declared host-global `cpu_diagnostics_*` columns on
 * `server_host_samples` (so a CPU-only diagnostics query needs no join at
 * all), while its 12 memory gauges/rates live in the singleton
 * `server_memory_diagnostics_samples` table, left-joined on
 * `(server_id, sampled_at)` — see `HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS` and
 * `MEMORY_DIAGNOSTICS_FIELDS` below.
 *
 * v5 deleted every per-core table. `server_cpu_hotspot_samples` (the 4
 * busiest cores per sample) and `server_cpu_core_samples` (live-only, one
 * row per online core) are both gone, along with the contract families that
 * fed them — a 64-core host now costs exactly the same storage as a 2-core
 * one.
 */

import {
  type BlockDeviceSample,
  type DatabaseProxySample,
  type DiagnosticsCpuSample,
  type DiagnosticsMemorySample,
  type DockerUsageSample,
  type FilesystemSample,
  type GpuSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type IngressSourceSample,
  type NetworkDeviceSample,
  type RouterSample,
  STORAGE_ENGINE_KEYS,
  STORAGE_FLAT_FIELD_NAMES,
  storageEngineFieldName,
  type StorageEngineSample,
} from '../../contract.ts'

/** Hot raw-sample tables (recent, un-archived rows). */
export const HOST_SAMPLES_TABLE = 'server_host_samples'
export const NETWORK_SAMPLES_TABLE = 'server_network_samples'
export const FILESYSTEM_SAMPLES_TABLE = 'server_filesystem_samples'
export const BLOCK_SAMPLES_TABLE = 'server_block_samples'
export const GPU_SAMPLES_TABLE = 'server_gpu_samples'
export const HARDWARE_SIGNAL_SAMPLES_TABLE = 'server_hardware_signal_samples'
export const INGRESS_SAMPLES_TABLE = 'server_ingress_samples'
export const DATABASE_PROXY_SAMPLES_TABLE = 'server_database_proxy_samples'
export const ROUTER_SAMPLES_TABLE = 'server_router_samples'
export const STORAGE_SAMPLES_TABLE = 'server_storage_samples'
export const DOCKER_SAMPLES_TABLE = 'server_docker_samples'
export const MEMORY_DIAGNOSTICS_SAMPLES_TABLE = 'server_memory_diagnostics_samples'
export const METRIC_EVENTS_TABLE = 'server_metric_events'

/** Connection-status transition table — untouched by the v5 cutover. */
export const STATUS_EVENTS_TABLE = 'server_status_events'

/**
 * Sidecar version written after a successful open. The current DuckDB store
 * is **7** — the only supported on-disk layout. `openDuckDb` discards
 * `metrics.duckdb`, `parquet/`, `tmp/`, and `schema-version` when the marker
 * is missing, corrupt, or not this value, then creates the current store.
 * There is no in-place migration and no supported path for older files.
 *
 * Bumped 6 → 7 when `managed.router` gained its own `server_router_samples`
 * table and the ingress/database-proxy tables gained columns: every DDL
 * statement is `CREATE TABLE IF NOT EXISTS`, so without a marker bump an
 * existing file would silently keep its old, narrower columns and reject
 * every insert. Bumped 7 → 8 for the same reason when `managed.storage` and
 * `managed.docker` gained `server_storage_samples` / `server_docker_samples`.
 */
export const DUCKDB_SCHEMA_MARKER_VERSION = 8

// ---------------------------------------------------------------------------
// Field ordering — hand-declared `Record<keyof T, true>` literals so a
// missing or renamed `contract.ts` field fails the TypeScript build
// instead of silently dropping a column. `Object.keys()` on each literal
// gives a stable, deterministic field order (object literal insertion order).
// ---------------------------------------------------------------------------

export type HostMetricGroup = keyof HostMetrics

/** Exhaustive over `HostMetrics`'s keys — a group added/removed there fails this literal to compile. */
const HOST_GROUP_MARKERS: Record<HostMetricGroup, true> = {
  cpu: true,
  kernel: true,
  memory: true,
  storage: true,
  network: true,
}

export const HOST_METRIC_GROUPS: readonly HostMetricGroup[] = Object.keys(
  HOST_GROUP_MARKERS
) as HostMetricGroup[]

export type HostFieldRef = { group: HostMetricGroup; field: string }

const HOST_CPU_FIELDS: Record<keyof HostCpuMetrics, true> = {
  busyPercent: true,
  userPercent: true,
  systemPercent: true,
  iowaitPercent: true,
  stealPercent: true,
  softirqPercent: true,
  pressureSomePercent: true,
  saturatedCoreCount: true,
  procsRunning: true,
  procsBlocked: true,
  processCount: true,
}

const HOST_KERNEL_FIELDS: Record<keyof HostKernelMetrics, true> = {
  fileHandlesUsedPercent: true,
  conntrackUsedPercent: true,
}

const HOST_MEMORY_FIELDS: Record<keyof HostMemoryMetrics, true> = {
  usedBytes: true,
  cachedFilesBytes: true,
  swapUsedBytes: true,
  pressureSomePercent: true,
  pressureFullPercent: true,
  swapInBytesPerSecond: true,
  swapOutBytesPerSecond: true,
  majorPageFaultsPerSecond: true,
}

const HOST_STORAGE_FIELDS: Record<keyof HostStorageMetrics, true> = {
  ioPressureSomePercent: true,
  ioPressureFullPercent: true,
  diskReadBytesPerSecond: true,
  diskWriteBytesPerSecond: true,
  diskLatencyMs: true,
  rootFilesystemAvailableBytes: true,
  rootFilesystemFreeInodes: true,
}

const HOST_NETWORK_FIELDS: Record<keyof HostNetworkMetrics, true> = {
  tcpRetransmitPercent: true,
  softnetDropsPerSecond: true,
}

const HOST_GROUP_FIELD_RECORDS: Record<HostMetricGroup, Record<string, true>> = {
  cpu: HOST_CPU_FIELDS,
  kernel: HOST_KERNEL_FIELDS,
  memory: HOST_MEMORY_FIELDS,
  storage: HOST_STORAGE_FIELDS,
  network: HOST_NETWORK_FIELDS,
}

/**
 * Every `HostMetrics` leaf field, in declared group order — 31 entries
 * (11 + 2 + 7 + 9 + 2). Group coverage is compile-time exhaustive
 * (`HOST_GROUP_MARKERS` above is typed `Record<keyof HostMetrics, true>`);
 * field coverage within each group is compile-time exhaustive via that
 * group's own `Record<keyof T, true>` literal (`HOST_CPU_FIELDS` etc.) — a
 * field or group added to `contract.ts` without a matching entry fails
 * the TypeScript build rather than silently missing a column.
 */
export const HOST_METRIC_FIELD_REFS: readonly HostFieldRef[] = HOST_METRIC_GROUPS.flatMap(
  (group) =>
    Object.keys(HOST_GROUP_FIELD_RECORDS[group]).map((field) => ({
      group,
      field,
    }))
)

const NETWORK_FIELDS: Record<keyof Omit<NetworkDeviceSample, 'deviceId'>, true> = {
  receiveBytesPerSecond: true,
  transmitBytesPerSecond: true,
  receiveErrorsPerSecond: true,
  transmitErrorsPerSecond: true,
  receiveDropsPerSecond: true,
  transmitDropsPerSecond: true,
}
export const NETWORK_METRIC_FIELDS: readonly string[] = Object.keys(NETWORK_FIELDS)

/**
 * The root filesystem never gets a row here: its capacity is carried
 * exclusively by `server_host_samples`'s `storage_root_filesystem_available_bytes`/
 * `storage_root_filesystem_free_inodes` columns (`HOST_STORAGE_FIELDS` above
 * — `rootFilesystemAvailableBytes`/`rootFilesystemFreeInodes` are ordinary
 * host-table gauges, not a duplicate of filesystem-table data), because the
 * collector (`turbopaneld`'s `collector/filesystem.ts`) never emits the
 * root-tagged topology entry into `sample.filesystems[]` in the first place.
 * A server's semantic filesystem picture is this table's non-root rows
 * joined against the topology snapshot's `FilesystemTopology.roles` (hosting/
 * docker/application/custom) for labeling — never a synthetic root row here.
 */
const FILESYSTEM_FIELDS: Record<keyof Omit<FilesystemSample, 'filesystemId'>, true> = {
  availableBytes: true,
  freeInodes: true,
}
export const FILESYSTEM_METRIC_FIELDS: readonly string[] = Object.keys(FILESYSTEM_FIELDS)

const BLOCK_FIELDS: Record<keyof Omit<BlockDeviceSample, 'deviceId'>, true> = {
  readBytesPerSecond: true,
  writeBytesPerSecond: true,
  readOpsPerSecond: true,
  writeOpsPerSecond: true,
  readLatencyMs: true,
  writeLatencyMs: true,
  utilizationPercent: true,
  queueDepth: true,
}
export const BLOCK_METRIC_FIELDS: readonly string[] = Object.keys(BLOCK_FIELDS)

const GPU_FIELDS: Record<keyof Omit<GpuSample, 'gpuId'>, true> = {
  utilizationPercent: true,
  memoryUsedBytes: true,
  memoryActivityPercent: true,
  pcieReceiveBytesPerSecond: true,
  pcieTransmitBytesPerSecond: true,
  throttlePercent: true,
}
export const GPU_METRIC_FIELDS: readonly string[] = Object.keys(GPU_FIELDS)

const INGRESS_FIELDS: Record<keyof Omit<IngressSourceSample, 'sourceId' | 'sourceKind'>, true> = {
  requests: true,
  responses2xx: true,
  responses3xx: true,
  responses4xx: true,
  responses5xx: true,
  requestErrors: true,
  requestBytes: true,
  responseBytes: true,
  requestDurationSecondsSum: true,
  bucket10ms: true,
  bucket50ms: true,
  bucket100ms: true,
  bucket500ms: true,
  bucket1s: true,
  bucket5s: true,
  requestsInFlight: true,
  upstreamsHealthy: true,
  upstreamsTotal: true,
  retries: true,
}
export const INGRESS_METRIC_FIELDS: readonly string[] = Object.keys(INGRESS_FIELDS)

const DATABASE_PROXY_FIELDS: Record<
  keyof Omit<DatabaseProxySample, 'sourceId' | 'sourceKind'>,
  true
> = {
  queries: true,
  slowQueries: true,
  queryLatencyMsAvg: true,
  backendLatencyMsAvg: true,
  activeTransactions: true,
  clientConnections: true,
  clientConnectionsCreated: true,
  clientConnectionsAborted: true,
  connectionsRejectedMaxConns: true,
  backendConnections: true,
  backendConnectionsCreated: true,
  backendConnectionsAborted: true,
  connectionErrors: true,
  backendsUp: true,
  backendsTotal: true,
  bytesFromBackends: true,
  bytesToBackends: true,
}
export const DATABASE_PROXY_METRIC_FIELDS: readonly string[] = Object.keys(DATABASE_PROXY_FIELDS)

/**
 * The shared-hosting HTTP router family — host-wide and singleton, so its
 * table carries no entity id column (same shape as
 * `server_memory_diagnostics_samples`). All 12 contract fields get a real
 * column: unlike the Analytics Engine backend there is no 19-slot page to
 * budget against here, so this list has no spare-slot concept at all.
 */
const ROUTER_FIELDS: Record<keyof RouterSample, true> = {
  backendsUp: true,
  backendsTotal: true,
  servicesTotal: true,
  routersTotal: true,
  retries: true,
  backendErrors5xx: true,
  backendLatencyMsAvg: true,
  backendRequests: true,
  httpOpenConnections: true,
  configReloads: true,
  configLastReloadAgeSeconds: true,
  tlsCertSoonestExpiryDays: true,
}
export const ROUTER_METRIC_FIELDS: readonly string[] = Object.keys(ROUTER_FIELDS)

/**
 * The CPU half of `diagnostics` — a small, intentional, hand-declared
 * exception to the `HOST_METRIC_FIELD_REFS` derivation pattern above, since
 * `diagnostics` lives outside `HostMetrics`'s `host` object but is still
 * host-global (one value per sample, not per entity). Keeping these 7 on the
 * host row is what lets a CPU-only diagnostics query answer without touching
 * the memory-diagnostics table.
 */
const HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS: Record<keyof DiagnosticsCpuSample, true> = {
  averageFrequencyMHz: true,
  minimumFrequencyMHz: true,
  maximumFrequencyMHz: true,
  contextSwitchesPerSecond: true,
  interruptsPerSecond: true,
  forksPerSecond: true,
  cpuIrqPercent: true,
}
export const HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST: readonly string[] = Object.keys(
  HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS
)

/**
 * The memory half of `diagnostics` — 12 fields. v6 dropped seven
 * never-charted `/proc/meminfo` gauges (`pageTablesBytes`,
 * `kernelStackBytes`, `commitLimitBytes`, and the four active/inactive
 * anon/file gauges) that v5's `memoryDetail` carried.
 */
const MEMORY_DIAGNOSTICS_FIELDS: Record<keyof DiagnosticsMemorySample, true> = {
  memoryFreeBytes: true,
  cachedBytes: true,
  anonPagesBytes: true,
  slabReclaimableBytes: true,
  slabUnreclaimableBytes: true,
  dirtyBytes: true,
  writebackBytes: true,
  shmemBytes: true,
  committedAsBytes: true,
  pageScanDirectPerSecond: true,
  pageScanKswapdPerSecond: true,
  compactionStallsPerSecond: true,
}
export const MEMORY_DIAGNOSTICS_METRIC_FIELDS: readonly string[] =
  Object.keys(MEMORY_DIAGNOSTICS_FIELDS)

/**
 * Host-wide managed-storage accounting — singleton per sample, so its table
 * carries no entity id column (same shape as `server_router_samples`).
 *
 * Unlike the Analytics Engine backend, this table is **not** split at the
 * `managed.storage` / `managed.docker` family boundary: DuckDB has no 19-slot
 * page to budget against, so the Docker breakdown rides here too (prefixed
 * `docker_*`) and a storage panel answers from one row with no join. The
 * separate `server_docker_samples` table below keeps the AE family boundary
 * reproducible for cross-backend comparisons; the duplication is deliberate
 * and costs one narrow row per sample.
 *
 * The nested per-engine groups flatten to `<engine><Field>` before
 * snake_casing, which is what yields `postgres_instances_running` and keeps
 * every column name unique inside the single wide table.
 */
const STORAGE_ENGINE_FIELD_MARKERS: Record<keyof StorageEngineSample, true> = {
  instancesRunning: true,
  instancesHealthy: true,
  connectionsUsed: true,
  connectionsMax: true,
}

/**
 * Every per-engine column, flattened — derived from the compile-time
 * exhaustive marker record above crossed with the contract's engine list, so
 * a field added to `StorageEngineSample` fails the TypeScript build rather
 * than silently missing three columns.
 */
export const STORAGE_ENGINE_METRIC_FIELDS: readonly string[] = STORAGE_ENGINE_KEYS.flatMap(
  (engine) =>
    (Object.keys(STORAGE_ENGINE_FIELD_MARKERS) as (keyof StorageEngineSample)[]).map((field) =>
      storageEngineFieldName(engine, field)
    )
)

/** `StorageSample`'s seven flat (non-engine) field names, in contract order. */
export const STORAGE_FLAT_METRIC_FIELDS: readonly string[] = [...STORAGE_FLAT_FIELD_NAMES]

/**
 * The Docker breakdown as it appears **on the storage row** — the same ten
 * `DockerUsageSample` fields, `docker_`-prefixed so they cannot collide with
 * `docker_used_bytes` (the total, which comes from `StorageSample`).
 */
const DOCKER_USAGE_FIELDS: Record<keyof DockerUsageSample, true> = {
  layersBytes: true,
  imagesCount: true,
  imagesReclaimableBytes: true,
  containersBytes: true,
  containersCount: true,
  volumesBytes: true,
  volumesCount: true,
  volumesReclaimableBytes: true,
  buildCacheBytes: true,
  buildCacheReclaimableBytes: true,
}
export const DOCKER_USAGE_METRIC_FIELDS: readonly string[] = Object.keys(DOCKER_USAGE_FIELDS)

/**
 * The four topology filesystem ids a storage row is labeled with. Nullable
 * and currently always written `NULL`: nothing on the wire carries them yet
 * (`StorageSample` is pure numbers), so the columns exist for the phase that
 * threads topology identity onto the row rather than being back-filled with a
 * guess.
 */
export const STORAGE_FILESYSTEM_ID_COLUMNS = [
  'hosting_filesystem_id',
  'backup_filesystem_id',
  'docker_filesystem_id',
  'logs_filesystem_id',
] as const

function snakeCase(field: string): string {
  return field.replaceAll(/([A-Z])/g, '_$1').toLowerCase()
}

/**
 * DuckDB column name for a host metric field, prefixed by its group —
 * `host.cpu.pressureSomePercent` and `host.memory.pressureSomePercent` both
 * snake_case to `pressure_some_percent` on their own, so the group prefix
 * (`cpu_pressure_some_percent` / `memory_pressure_some_percent`) is what
 * keeps every host column name unique within the single wide table.
 */
export function hostMetricColumnName(group: HostMetricGroup, field: string): string {
  if (!(field in HOST_GROUP_FIELD_RECORDS[group])) {
    throw new TypeError(`unknown host metrics field: ${group}.${field}`)
  }
  return `${group}_${snakeCase(field)}`
}

/** DuckDB column name for a per-entity metric field — plain snake_case (no group collision within a single-family table). */
export function entityMetricColumnName(field: string): string {
  return snakeCase(field)
}

/**
 * DuckDB column name for one of the Docker breakdown's fields **on the
 * storage row** — `docker_`-prefixed so `layersBytes` becomes
 * `docker_layers_bytes` and cannot collide with the `docker_used_bytes`
 * total. The standalone `server_docker_samples` table uses the unprefixed
 * `entityMetricColumnName` instead, matching its AE family exactly.
 */
export function dockerUsageStorageColumnName(field: string): string {
  if (!(field in DOCKER_USAGE_FIELDS)) {
    throw new TypeError(`unknown Docker usage field: ${field}`)
  }
  return `docker_${snakeCase(field)}`
}

/** DuckDB column name for one of the diagnostics CPU half's hand-declared host-global scalar fields. */
export function cpuDiagnosticsHostColumnName(field: string): string {
  if (!(field in HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS)) {
    throw new TypeError(`unknown diagnostics CPU host-global field: ${field}`)
  }
  return `cpu_diagnostics_${snakeCase(field)}`
}

// ---------------------------------------------------------------------------
// Common metadata columns shared by every family table except
// `server_metric_events` (leaner, event-shaped) and `server_status_events`
// (untouched v3 shape).
// ---------------------------------------------------------------------------

export const COMMON_METADATA_COLUMNS = [
  'server_id',
  'sampled_at',
  'received_at',
  'interval_seconds',
  'sequence',
  'topology_generation',
  'boot_generation',
] as const

const COMMON_METADATA_COLUMN_DEFS = [
  'server_id UUID NOT NULL',
  'sampled_at TIMESTAMP NOT NULL',
  'received_at TIMESTAMP NOT NULL',
  'interval_seconds SMALLINT NOT NULL',
  'sequence BIGINT NOT NULL',
  'topology_generation INTEGER NOT NULL',
  'boot_generation INTEGER NOT NULL',
]

function indent(lines: readonly string[]): string {
  return lines.map((line) => `    ${line}`).join(',\n')
}

function hostSamplesTableDdl(): string {
  const metricColumns = HOST_METRIC_FIELD_REFS.map(
    (ref) => `${hostMetricColumnName(ref.group, ref.field)} DOUBLE`
  )
  const cpuDiagnosticsColumns = HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST.map(
    (field) => `${cpuDiagnosticsHostColumnName(field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_SAMPLES_TABLE} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...metricColumns, ...cpuDiagnosticsColumns]),
    `)`,
  ].join('\n')
}

/** DDL for a per-entity family table: common metadata + entity id column(s) + nullable DOUBLE metric columns. */
function entitySamplesTableDdl(
  table: string,
  idColumnDefs: readonly string[],
  metricFields: readonly string[]
): string {
  const metricColumns = metricFields.map((field) => `${entityMetricColumnName(field)} DOUBLE`)
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...idColumnDefs, ...metricColumns]),
    `)`,
  ].join('\n')
}

function networkSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    NETWORK_SAMPLES_TABLE,
    ['device_id VARCHAR NOT NULL'],
    NETWORK_METRIC_FIELDS
  )
}

function filesystemSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    FILESYSTEM_SAMPLES_TABLE,
    ['filesystem_id VARCHAR NOT NULL'],
    FILESYSTEM_METRIC_FIELDS
  )
}

function blockSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    BLOCK_SAMPLES_TABLE,
    ['device_id VARCHAR NOT NULL'],
    BLOCK_METRIC_FIELDS
  )
}

function gpuSamplesTableDdl(): string {
  return entitySamplesTableDdl(GPU_SAMPLES_TABLE, ['gpu_id VARCHAR NOT NULL'], GPU_METRIC_FIELDS)
}

/** Singleton per sample (no entity id column) — one row per sample when `router` is present. */
function routerSamplesTableDdl(): string {
  const metricColumns = ROUTER_METRIC_FIELDS.map(
    (field) => `${entityMetricColumnName(field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${ROUTER_SAMPLES_TABLE} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...metricColumns]),
    `)`,
  ].join('\n')
}

/**
 * Singleton per sample (no entity id column) — one row per sample when
 * `storage` is present. Column order is the storage story end to end: the
 * used-byte totals (with the Docker breakdown expanded inline after
 * `docker_used_bytes`, since that is what the total decomposes into), then
 * the free-byte headrooms, then the per-engine census, then the four
 * topology-id labels.
 */
function storageSamplesTableDdl(): string {
  const metricColumns = storageSamplesMetricColumnNames().map((column) => `${column} DOUBLE`)
  const idColumns = STORAGE_FILESYSTEM_ID_COLUMNS.map((column) => `${column} VARCHAR`)
  return [
    `CREATE TABLE IF NOT EXISTS ${STORAGE_SAMPLES_TABLE} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...metricColumns, ...idColumns]),
    `)`,
  ].join('\n')
}

/**
 * Singleton per sample (no entity id column) — one row per sample when
 * `dockerUsage` survives the capability plan. Kept as its own table even
 * though `server_storage_samples` already carries the same ten values, so the
 * AE `managed.docker` family boundary stays reproducible on this backend —
 * the same precedent `server_memory_diagnostics_samples` set for the
 * diagnostics memory half.
 */
function dockerSamplesTableDdl(): string {
  const metricColumns = DOCKER_USAGE_METRIC_FIELDS.map(
    (field) => `${entityMetricColumnName(field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${DOCKER_SAMPLES_TABLE} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...metricColumns]),
    `)`,
  ].join('\n')
}

/** Singleton per sample (no entity id column) — one row per sample when `diagnostics` is present. */
function memoryDiagnosticsSamplesTableDdl(): string {
  const metricColumns = MEMORY_DIAGNOSTICS_METRIC_FIELDS.map(
    (field) => `${entityMetricColumnName(field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${MEMORY_DIAGNOSTICS_SAMPLES_TABLE} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...metricColumns]),
    `)`,
  ].join('\n')
}

/** Long-form table: one row per (sample, signal), `kind` + `value` columns rather than one column per signal kind. */
function hardwareSignalSamplesTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${HARDWARE_SIGNAL_SAMPLES_TABLE} (`,
    indent([
      ...COMMON_METADATA_COLUMN_DEFS,
      'signal_id VARCHAR NOT NULL',
      'kind VARCHAR NOT NULL',
      'value DOUBLE',
    ]),
    `)`,
  ].join('\n')
}

function ingressSamplesTableDdl(): string {
  return entitySamplesTableDdl(
    INGRESS_SAMPLES_TABLE,
    ['source_id VARCHAR NOT NULL', 'source_kind VARCHAR NOT NULL'],
    INGRESS_METRIC_FIELDS
  )
}

function databaseProxySamplesTableDdl(): string {
  return entitySamplesTableDdl(
    DATABASE_PROXY_SAMPLES_TABLE,
    ['source_id VARCHAR NOT NULL', 'source_kind VARCHAR NOT NULL'],
    DATABASE_PROXY_METRIC_FIELDS
  )
}

/** Discrete event rows (`METRIC_EVENT_KINDS`) — leaner shape than the sample tables, no interval/sequence columns. */
function metricEventsTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${METRIC_EVENTS_TABLE} (`,
    indent([
      'server_id UUID NOT NULL',
      'event_id VARCHAR NOT NULL',
      `"at" TIMESTAMP NOT NULL`,
      'received_at TIMESTAMP NOT NULL',
      'kind VARCHAR NOT NULL',
      'severity VARCHAR NOT NULL',
      'topology_generation INTEGER NOT NULL',
      'entity_id VARCHAR',
      'source VARCHAR',
      'payload VARCHAR',
    ]),
    `)`,
  ].join('\n')
}

function statusEventsTableDdl(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${STATUS_EVENTS_TABLE} (`,
    indent([
      'server_id UUID NOT NULL',
      `"at" TIMESTAMP NOT NULL`,
      'connected BOOLEAN NOT NULL',
      'reason VARCHAR NOT NULL',
    ]),
    `)`,
  ].join('\n')
}

/** `(server_id, sampled_at)` + `(server_id, <entity id>, sampled_at)` indexes for a per-entity family table. */
function entityIndexes(table: string, idColumn: string): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${table}_server_time ON ${table} (server_id, sampled_at)`,
    `CREATE INDEX IF NOT EXISTS idx_${table}_entity ON ${table} (server_id, ${idColumn}, sampled_at)`,
  ]
}

/**
 * Ordered idempotent DDL for every table plus the range-scan indexes queries
 * scan on: `(server_id, <time column>)` for every family table, plus
 * `(server_id, <entity id>, sampled_at)` for the per-entity families.
 */
export function buildSchemaStatements(): string[] {
  return [
    hostSamplesTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${HOST_SAMPLES_TABLE}_server_time ON ${HOST_SAMPLES_TABLE} (server_id, sampled_at)`,
    networkSamplesTableDdl(),
    ...entityIndexes(NETWORK_SAMPLES_TABLE, 'device_id'),
    filesystemSamplesTableDdl(),
    ...entityIndexes(FILESYSTEM_SAMPLES_TABLE, 'filesystem_id'),
    blockSamplesTableDdl(),
    ...entityIndexes(BLOCK_SAMPLES_TABLE, 'device_id'),
    gpuSamplesTableDdl(),
    ...entityIndexes(GPU_SAMPLES_TABLE, 'gpu_id'),
    memoryDiagnosticsSamplesTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${MEMORY_DIAGNOSTICS_SAMPLES_TABLE}_server_time ON ${MEMORY_DIAGNOSTICS_SAMPLES_TABLE} (server_id, sampled_at)`,
    hardwareSignalSamplesTableDdl(),
    ...entityIndexes(HARDWARE_SIGNAL_SAMPLES_TABLE, 'signal_id'),
    ingressSamplesTableDdl(),
    ...entityIndexes(INGRESS_SAMPLES_TABLE, 'source_id'),
    databaseProxySamplesTableDdl(),
    ...entityIndexes(DATABASE_PROXY_SAMPLES_TABLE, 'source_id'),
    routerSamplesTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${ROUTER_SAMPLES_TABLE}_server_time ON ${ROUTER_SAMPLES_TABLE} (server_id, sampled_at)`,
    storageSamplesTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${STORAGE_SAMPLES_TABLE}_server_time ON ${STORAGE_SAMPLES_TABLE} (server_id, sampled_at)`,
    dockerSamplesTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${DOCKER_SAMPLES_TABLE}_server_time ON ${DOCKER_SAMPLES_TABLE} (server_id, sampled_at)`,
    metricEventsTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${METRIC_EVENTS_TABLE}_server_time ON ${METRIC_EVENTS_TABLE} (server_id, "at")`,
    statusEventsTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${STATUS_EVENTS_TABLE}_server_time ON ${STATUS_EVENTS_TABLE} (server_id, "at")`,
  ]
}

// ---------------------------------------------------------------------------
// Insert column lists (base + entity id(s) + metrics, in DDL order) — the
// single source of truth `store.ts` builds its parameterized INSERTs from.
// ---------------------------------------------------------------------------

function hostSamplesDoubleColumnNames(): string[] {
  return [
    ...HOST_METRIC_FIELD_REFS.map((ref) => hostMetricColumnName(ref.group, ref.field)),
    ...HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST.map(cpuDiagnosticsHostColumnName),
  ]
}

export function hostSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...hostSamplesDoubleColumnNames()]
}

export function networkSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'device_id',
    ...NETWORK_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function filesystemSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'filesystem_id',
    ...FILESYSTEM_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function blockSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'device_id',
    ...BLOCK_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function gpuSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, 'gpu_id', ...GPU_METRIC_FIELDS.map(entityMetricColumnName)]
}

export function memoryDiagnosticsSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    ...MEMORY_DIAGNOSTICS_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function hardwareSignalSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, 'signal_id', 'kind', 'value']
}

export function ingressSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'source_id',
    'source_kind',
    ...INGRESS_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function databaseProxySamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    'source_id',
    'source_kind',
    ...DATABASE_PROXY_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

export function routerSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...ROUTER_METRIC_FIELDS.map(entityMetricColumnName)]
}

/**
 * `server_storage_samples`' metric column names, in DDL order — the single
 * source of truth both the DDL and `store.ts`'s parameterized INSERT derive
 * from, so a column can never be declared in one order and bound in another.
 */
export function storageSamplesMetricColumnNames(): string[] {
  return [
    entityMetricColumnName('hostingUsedBytes'),
    entityMetricColumnName('backupUsedBytes'),
    entityMetricColumnName('dockerUsedBytes'),
    ...DOCKER_USAGE_METRIC_FIELDS.map(dockerUsageStorageColumnName),
    entityMetricColumnName('logsUsedBytes'),
    entityMetricColumnName('hostingFreeBytes'),
    entityMetricColumnName('backupFreeBytes'),
    entityMetricColumnName('logsFreeBytes'),
    ...STORAGE_ENGINE_METRIC_FIELDS.map(entityMetricColumnName),
  ]
}

/**
 * `server_storage_samples`' metric values, in the same order
 * {@link storageSamplesMetricColumnNames} declares — the storage half read
 * from `StorageSample`, the ten `docker_*` breakdown columns from the
 * separate (capability-gated) `DockerUsageSample`. A sample with storage but
 * no Docker breakdown writes real `NULL`s in the breakdown columns, which is
 * exactly "Docker usage was not reported", never zero bytes.
 */
export const STORAGE_ROW_VALUE_PLAN = {
  leadingFlatFields: ['hostingUsedBytes', 'backupUsedBytes', 'dockerUsedBytes'] as const,
  trailingFlatFields: [
    'logsUsedBytes',
    'hostingFreeBytes',
    'backupFreeBytes',
    'logsFreeBytes',
  ] as const,
} as const

export function storageSamplesInsertColumns(): string[] {
  return [
    ...COMMON_METADATA_COLUMNS,
    ...storageSamplesMetricColumnNames(),
    ...STORAGE_FILESYSTEM_ID_COLUMNS,
  ]
}

export function dockerSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...DOCKER_USAGE_METRIC_FIELDS.map(entityMetricColumnName)]
}

export function metricEventsInsertColumns(): string[] {
  return [
    'server_id',
    'event_id',
    `"at"`,
    'received_at',
    'kind',
    'severity',
    'topology_generation',
    'entity_id',
    'source',
    'payload',
  ]
}

// ---------------------------------------------------------------------------
// Module-load invariant: no duplicate `group.field` entry in
// `HOST_METRIC_FIELD_REFS` (which would silently drop or double-count a
// column). Full coverage of every `HostMetrics` leaf is guaranteed at
// compile time instead: `HOST_GROUP_MARKERS` is `Record<keyof HostMetrics, true>`
// (every group covered), and each group's own `Record<keyof T, true>`
// literal (`HOST_CPU_FIELDS` etc.) covers every field within it — a field or
// group added to `contract.ts` without a matching literal entry fails the
// TypeScript build. The schema test "every leaf metric of a real v5 sample
// maps to a known host column" additionally exercises this against a real
// sanitized sample at runtime.
// ---------------------------------------------------------------------------

function assertHostFieldRefsCoverContract(): void {
  const declared = new Set(HOST_METRIC_FIELD_REFS.map((ref) => `${ref.group}.${ref.field}`))
  if (declared.size !== HOST_METRIC_FIELD_REFS.length) {
    throw new TypeError('HOST_METRIC_FIELD_REFS has duplicate group.field entries')
  }
}
assertHostFieldRefsCoverContract()
