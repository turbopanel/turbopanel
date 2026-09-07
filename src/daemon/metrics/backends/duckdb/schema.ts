/**
 * DuckDB metrics schema DDL for the v5 contract — the DuckDB backend's own
 * private field map, independent of `../cloudflare/field-map-v5.ts`'s AE
 * positional layout.
 *
 * v5 replaces v3's single wide `server_metric_samples` table with one table
 * per entity family (host, network, filesystem, block, GPU, hardware signal,
 * ingress, database proxy) plus a discrete events table, mirroring
 * `contract-v5.ts`'s per-entity grouping. Every metric column is a real
 * nullable `DOUBLE` with a real SQL `NULL` for "missing" — no positional
 * `doubleN`/`blobN` slots, no missing-metric sentinel, and (unlike v3) no
 * `parts` marker column: v5 has no `MetricPart` allowlist, so a family's
 * table simply has no row for a sample that never reported that family.
 *
 * `cpuDetail` / `memoryDetail` are the two remaining "detail families".
 * `server_memory_detail_samples` holds `memoryDetail`'s 20 fields;
 * `cpuDetail`'s 7 scalar fields (`averageFrequencyMHz` etc.) are
 * hand-declared host-global columns on `server_host_samples` — see
 * `HOST_GLOBAL_CPU_DETAIL_FIELDS` below.
 *
 * v5 deleted every per-core table. `server_cpu_hotspot_samples` (the 4
 * busiest cores per sample) and `server_cpu_core_samples` (live-only, one
 * row per online core) are both gone, along with the contract families that
 * fed them — a 64-core host now costs exactly the same storage as a 2-core
 * one.
 */

import type {
  BlockDeviceSampleV5,
  CpuDetailSampleV5,
  DatabaseProxySampleV5,
  FilesystemSampleV5,
  GpuSampleV5,
  HostCpuMetricsV5,
  HostKernelMetricsV5,
  HostMemoryMetricsV5,
  HostMetricsV5,
  HostNetworkMetricsV5,
  HostStorageMetricsV5,
  IngressSourceSampleV5,
  MemoryDetailSampleV5,
  NetworkDeviceSampleV5,
} from '../../contract-v5.ts'

/** Hot raw-sample tables (recent, un-archived rows). */
export const HOST_SAMPLES_TABLE = 'server_host_samples'
export const NETWORK_SAMPLES_TABLE = 'server_network_samples'
export const FILESYSTEM_SAMPLES_TABLE = 'server_filesystem_samples'
export const BLOCK_SAMPLES_TABLE = 'server_block_samples'
export const GPU_SAMPLES_TABLE = 'server_gpu_samples'
export const HARDWARE_SIGNAL_SAMPLES_TABLE = 'server_hardware_signal_samples'
export const INGRESS_SAMPLES_TABLE = 'server_ingress_samples'
export const DATABASE_PROXY_SAMPLES_TABLE = 'server_database_proxy_samples'
export const MEMORY_DETAIL_SAMPLES_TABLE = 'server_memory_detail_samples'
export const METRIC_EVENTS_TABLE = 'server_metric_events'

/** Connection-status transition table — untouched by the v5 cutover. */
export const STATUS_EVENTS_TABLE = 'server_status_events'

/**
 * Sidecar version written after a successful open. The current DuckDB store
 * is **6** — the only supported on-disk layout. `openDuckDb` discards
 * `metrics.duckdb`, `parquet/`, `tmp/`, and `schema-version` when the marker
 * is missing, corrupt, or not this value, then creates the current store.
 * There is no in-place migration and no supported path for older files.
 */
export const DUCKDB_SCHEMA_MARKER_VERSION = 5

// ---------------------------------------------------------------------------
// Field ordering — hand-declared `Record<keyof T, true>` literals so a
// missing or renamed `contract-v5.ts` field fails the TypeScript build
// instead of silently dropping a column. `Object.keys()` on each literal
// gives a stable, deterministic field order (object literal insertion order).
// ---------------------------------------------------------------------------

export type HostMetricGroupV5 = keyof HostMetricsV5

/** Exhaustive over `HostMetricsV5`'s keys — a group added/removed there fails this literal to compile. */
const HOST_GROUP_MARKERS: Record<HostMetricGroupV5, true> = {
  cpu: true,
  kernel: true,
  memory: true,
  storage: true,
  network: true,
}

export const HOST_METRIC_GROUPS: readonly HostMetricGroupV5[] = Object.keys(
  HOST_GROUP_MARKERS
) as HostMetricGroupV5[]

export type HostFieldRefV5 = { group: HostMetricGroupV5; field: string }

const HOST_CPU_FIELDS: Record<keyof HostCpuMetricsV5, true> = {
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

const HOST_KERNEL_FIELDS: Record<keyof HostKernelMetricsV5, true> = {
  fileHandlesUsedPercent: true,
  conntrackUsedPercent: true,
}

const HOST_MEMORY_FIELDS: Record<keyof HostMemoryMetricsV5, true> = {
  usedBytes: true,
  cachedFilesBytes: true,
  swapUsedBytes: true,
  pressureSomePercent: true,
  pressureFullPercent: true,
  swapInBytesPerSecond: true,
  swapOutBytesPerSecond: true,
  majorPageFaultsPerSecond: true,
}

const HOST_STORAGE_FIELDS: Record<keyof HostStorageMetricsV5, true> = {
  ioPressureSomePercent: true,
  ioPressureFullPercent: true,
  diskReadBytesPerSecond: true,
  diskWriteBytesPerSecond: true,
  diskLatencyMs: true,
  rootFilesystemAvailableBytes: true,
  rootFilesystemFreeInodes: true,
}

const HOST_NETWORK_FIELDS: Record<keyof HostNetworkMetricsV5, true> = {
  tcpRetransmitPercent: true,
  softnetDropsPerSecond: true,
}

const HOST_GROUP_FIELD_RECORDS: Record<HostMetricGroupV5, Record<string, true>> = {
  cpu: HOST_CPU_FIELDS,
  kernel: HOST_KERNEL_FIELDS,
  memory: HOST_MEMORY_FIELDS,
  storage: HOST_STORAGE_FIELDS,
  network: HOST_NETWORK_FIELDS,
}

/**
 * Every `HostMetricsV5` leaf field, in declared group order — 31 entries
 * (11 + 2 + 7 + 9 + 2). Group coverage is compile-time exhaustive
 * (`HOST_GROUP_MARKERS` above is typed `Record<keyof HostMetricsV5, true>`);
 * field coverage within each group is compile-time exhaustive via that
 * group's own `Record<keyof T, true>` literal (`HOST_CPU_FIELDS` etc.) — a
 * field or group added to `contract-v5.ts` without a matching entry fails
 * the TypeScript build rather than silently missing a column.
 */
export const HOST_METRIC_FIELD_REFS: readonly HostFieldRefV5[] = HOST_METRIC_GROUPS.flatMap(
  (group) =>
    Object.keys(HOST_GROUP_FIELD_RECORDS[group]).map((field) => ({
      group,
      field,
    }))
)

const NETWORK_FIELDS: Record<keyof Omit<NetworkDeviceSampleV5, 'deviceId'>, true> = {
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
const FILESYSTEM_FIELDS: Record<keyof Omit<FilesystemSampleV5, 'filesystemId'>, true> = {
  availableBytes: true,
  freeInodes: true,
}
export const FILESYSTEM_METRIC_FIELDS: readonly string[] = Object.keys(FILESYSTEM_FIELDS)

const BLOCK_FIELDS: Record<keyof Omit<BlockDeviceSampleV5, 'deviceId'>, true> = {
  readBytesPerSecond: true,
  writeBytesPerSecond: true,
  readOpsPerSecond: true,
  writeOpsPerSecond: true,
  readLatencyMs: true,
  writeLatencyMs: true,
  utilizationPercent: true,
  temperatureCelsius: true,
  queueDepth: true,
}
export const BLOCK_METRIC_FIELDS: readonly string[] = Object.keys(BLOCK_FIELDS)

const GPU_FIELDS: Record<keyof Omit<GpuSampleV5, 'gpuId'>, true> = {
  utilizationPercent: true,
  memoryUsedBytes: true,
  memoryActivityPercent: true,
  temperatureCelsius: true,
  memoryTemperatureCelsius: true,
  powerWatts: true,
  pcieReceiveBytesPerSecond: true,
  pcieTransmitBytesPerSecond: true,
  throttlePercent: true,
}
export const GPU_METRIC_FIELDS: readonly string[] = Object.keys(GPU_FIELDS)

const INGRESS_FIELDS: Record<keyof Omit<IngressSourceSampleV5, 'sourceId' | 'sourceKind'>, true> = {
  requests: true,
  responses2xx: true,
  responses3xx: true,
  responses4xx: true,
  responses5xx: true,
  requestErrors: true,
  requestBytes: true,
  responseBytes: true,
  requestDurationSecondsAvg: true,
  requestsUnder100ms: true,
  requestsUnder500ms: true,
  requestsUnder1s: true,
  requestsUnder5s: true,
  requestsInFlight: true,
  upstreamsHealthy: true,
  upstreamsTotal: true,
  retries: true,
}
export const INGRESS_METRIC_FIELDS: readonly string[] = Object.keys(INGRESS_FIELDS)

const DATABASE_PROXY_FIELDS: Record<
  keyof Omit<DatabaseProxySampleV5, 'sourceId' | 'sourceKind'>,
  true
> = {
  queries: true,
  slowQueries: true,
  connectionErrors: true,
  clientConnections: true,
  backendConnections: true,
  backendsUp: true,
}
export const DATABASE_PROXY_METRIC_FIELDS: readonly string[] = Object.keys(DATABASE_PROXY_FIELDS)

/**
 * `cpuDetail`'s 7 scalar fields — a small, intentional, hand-declared
 * exception to the `HOST_METRIC_FIELD_REFS` derivation pattern above, since
 * `cpuDetail` lives outside `HostMetricsV5`'s `host` object but is still
 * host-global (one value per sample, not per entity). v5 removed the
 * embedded busiest-core `hotspots` array, so this is now the whole family.
 */
const HOST_GLOBAL_CPU_DETAIL_FIELDS: Record<keyof CpuDetailSampleV5, true> = {
  averageFrequencyMHz: true,
  minimumFrequencyMHz: true,
  maximumFrequencyMHz: true,
  contextSwitchesPerSecond: true,
  interruptsPerSecond: true,
  forksPerSecond: true,
  cpuIrqPercent: true,
}
export const HOST_GLOBAL_CPU_DETAIL_FIELDS_LIST: readonly string[] = Object.keys(
  HOST_GLOBAL_CPU_DETAIL_FIELDS
)

const MEMORY_DETAIL_FIELDS: Record<keyof MemoryDetailSampleV5, true> = {
  memoryFreeBytes: true,
  cachedBytes: true,
  anonPagesBytes: true,
  slabReclaimableBytes: true,
  slabUnreclaimableBytes: true,
  dirtyBytes: true,
  writebackBytes: true,
  shmemBytes: true,
  pageTablesBytes: true,
  kernelStackBytes: true,
  committedAsBytes: true,
  commitLimitBytes: true,
  activeAnonBytes: true,
  inactiveAnonBytes: true,
  activeFileBytes: true,
  inactiveFileBytes: true,
  pageScanDirectPerSecond: true,
  pageScanKswapdPerSecond: true,
  compactionStallsPerSecond: true,
}
export const MEMORY_DETAIL_METRIC_FIELDS: readonly string[] = Object.keys(MEMORY_DETAIL_FIELDS)

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
export function hostMetricColumnName(group: HostMetricGroupV5, field: string): string {
  if (!(field in HOST_GROUP_FIELD_RECORDS[group])) {
    throw new TypeError(`unknown host metrics field: ${group}.${field}`)
  }
  return `${group}_${snakeCase(field)}`
}

/** DuckDB column name for a per-entity metric field — plain snake_case (no group collision within a single-family table). */
export function entityMetricColumnName(field: string): string {
  return snakeCase(field)
}

/** DuckDB column name for one of `cpuDetail`'s hand-declared host-global scalar fields. */
export function cpuDetailHostColumnName(field: string): string {
  if (!(field in HOST_GLOBAL_CPU_DETAIL_FIELDS)) {
    throw new TypeError(`unknown cpuDetail host-global field: ${field}`)
  }
  return `cpu_detail_${snakeCase(field)}`
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
  'collection_mode',
  'sequence',
  'topology_generation',
  'boot_generation',
] as const

const COMMON_METADATA_COLUMN_DEFS = [
  'server_id UUID NOT NULL',
  'sampled_at TIMESTAMP NOT NULL',
  'received_at TIMESTAMP NOT NULL',
  'interval_seconds SMALLINT NOT NULL',
  'collection_mode VARCHAR NOT NULL',
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
  const cpuDetailColumns = HOST_GLOBAL_CPU_DETAIL_FIELDS_LIST.map(
    (field) => `${cpuDetailHostColumnName(field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${HOST_SAMPLES_TABLE} (`,
    indent([...COMMON_METADATA_COLUMN_DEFS, ...metricColumns, ...cpuDetailColumns]),
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

/** Singleton per sample (no entity id column) — one row per sample when `memoryDetail` is present. */
function memoryDetailSamplesTableDdl(): string {
  const metricColumns = MEMORY_DETAIL_METRIC_FIELDS.map(
    (field) => `${entityMetricColumnName(field)} DOUBLE`
  )
  return [
    `CREATE TABLE IF NOT EXISTS ${MEMORY_DETAIL_SAMPLES_TABLE} (`,
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

/** Discrete event rows (`METRIC_EVENT_KINDS_V5`) — leaner shape than the sample tables, no interval/collection-mode/sequence columns. */
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
    memoryDetailSamplesTableDdl(),
    `CREATE INDEX IF NOT EXISTS idx_${MEMORY_DETAIL_SAMPLES_TABLE}_server_time ON ${MEMORY_DETAIL_SAMPLES_TABLE} (server_id, sampled_at)`,
    hardwareSignalSamplesTableDdl(),
    ...entityIndexes(HARDWARE_SIGNAL_SAMPLES_TABLE, 'signal_id'),
    ingressSamplesTableDdl(),
    ...entityIndexes(INGRESS_SAMPLES_TABLE, 'source_id'),
    databaseProxySamplesTableDdl(),
    ...entityIndexes(DATABASE_PROXY_SAMPLES_TABLE, 'source_id'),
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
    ...HOST_GLOBAL_CPU_DETAIL_FIELDS_LIST.map(cpuDetailHostColumnName),
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

export function memoryDetailSamplesInsertColumns(): string[] {
  return [...COMMON_METADATA_COLUMNS, ...MEMORY_DETAIL_METRIC_FIELDS.map(entityMetricColumnName)]
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
// column). Full coverage of every `HostMetricsV5` leaf is guaranteed at
// compile time instead: `HOST_GROUP_MARKERS` is `Record<keyof HostMetricsV5, true>`
// (every group covered), and each group's own `Record<keyof T, true>`
// literal (`HOST_CPU_FIELDS` etc.) covers every field within it — a field or
// group added to `contract-v5.ts` without a matching literal entry fails the
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
