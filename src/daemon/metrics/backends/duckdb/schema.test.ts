import { assertEquals, assertThrows } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSample } from '../../contract.ts'
import {
  BLOCK_METRIC_FIELDS,
  BLOCK_SAMPLES_TABLE,
  buildSchemaStatements,
  DATABASE_PROXY_METRIC_FIELDS,
  COMMON_METADATA_COLUMNS,
  DATABASE_PROXY_SAMPLES_TABLE,
  DOCKER_SAMPLES_TABLE,
  DOCKER_USAGE_METRIC_FIELDS,
  dockerSamplesInsertColumns,
  dockerUsageStorageColumnName,
  DUCKDB_SCHEMA_MARKER_VERSION,
  entityMetricColumnName,
  FILESYSTEM_METRIC_FIELDS,
  FILESYSTEM_SAMPLES_TABLE,
  GPU_METRIC_FIELDS,
  GPU_SAMPLES_TABLE,
  HARDWARE_SIGNAL_SAMPLES_TABLE,
  HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST,
  HOST_METRIC_FIELD_REFS,
  HOST_SAMPLES_TABLE,
  hostMetricColumnName,
  hostSamplesInsertColumns,
  INGRESS_METRIC_FIELDS,
  INGRESS_SAMPLES_TABLE,
  MEMORY_DIAGNOSTICS_METRIC_FIELDS,
  MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
  memoryDiagnosticsSamplesInsertColumns,
  METRIC_EVENTS_TABLE,
  STORAGE_ENGINE_METRIC_FIELDS,
  STORAGE_FILESYSTEM_ID_COLUMNS,
  STORAGE_SAMPLES_TABLE,
  storageSamplesInsertColumns,
  storageSamplesMetricColumnNames,
  NETWORK_METRIC_FIELDS,
  NETWORK_SAMPLES_TABLE,
  STATUS_EVENTS_TABLE,
} from './schema.ts'

it('DuckDB schema marker is 8', () => {
  assertEquals(DUCKDB_SCHEMA_MARKER_VERSION, 8)
})

it('hostMetricColumnName prefixes by group, avoiding cross-group collisions', () => {
  assertEquals(hostMetricColumnName('cpu', 'pressureSomePercent'), 'cpu_pressure_some_percent')
  assertEquals(
    hostMetricColumnName('memory', 'pressureSomePercent'),
    'memory_pressure_some_percent'
  )
  assertEquals(hostMetricColumnName('cpu', 'busyPercent'), 'cpu_busy_percent')
  assertThrows(() => hostMetricColumnName('cpu', 'nope'), TypeError, 'unknown host metrics field')
})

it('entityMetricColumnName maps camelCase fields to snake_case', () => {
  assertEquals(entityMetricColumnName('receiveBytesPerSecond'), 'receive_bytes_per_second')
  assertEquals(entityMetricColumnName('queueDepth'), 'queue_depth')
})

it('HOST_METRIC_FIELD_REFS has exactly 30 entries covering every host group, no duplicates', () => {
  assertEquals(HOST_METRIC_FIELD_REFS.length, 30)
  const columns = HOST_METRIC_FIELD_REFS.map((ref) => hostMetricColumnName(ref.group, ref.field))
  assertEquals(new Set(columns).size, columns.length)
  for (const column of columns) {
    assertEquals(/^[a-z][a-z0-9_]*$/.test(column), true, column)
  }
})

it('every leaf metric of a real v5 sample maps to a known host column', () => {
  const sample = buildMetricsSample({
    metadata: {
      version: 6,
      sampledAt: new Date().toISOString(),
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: 1,
        userPercent: 1,
        systemPercent: 1,
        iowaitPercent: 1,
        stealPercent: 1,
        softirqPercent: 1,
        pressureSomePercent: 1,
        saturatedCoreCount: 1,
        procsRunning: 1,
        procsBlocked: 1,
        processCount: 1,
      },
      kernel: { fileHandlesUsedPercent: 1, conntrackUsedPercent: 1 },
      memory: {
        usedBytes: 1,
        cachedFilesBytes: null,
        swapUsedBytes: 1,
        pressureSomePercent: 1,
        pressureFullPercent: 1,
        swapInBytesPerSecond: 1,
        swapOutBytesPerSecond: 1,
        majorPageFaultsPerSecond: 1,
      },
      storage: {
        ioPressureSomePercent: 1,
        ioPressureFullPercent: 1,
        diskReadBytesPerSecond: 1,
        diskWriteBytesPerSecond: 1,
        diskLatencyMs: 1.8,
        rootFilesystemAvailableBytes: 1,
        rootFilesystemFreeInodes: 1,
      },
      network: { tcpRetransmitPercent: 1, softnetDropsPerSecond: 1 },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  })
  const columnSet = new Set(hostSamplesInsertColumns())
  for (const group of ['cpu', 'kernel', 'memory', 'storage', 'network'] as const) {
    for (const field of Object.keys(sample.host[group])) {
      assertEquals(columnSet.has(hostMetricColumnName(group, field)), true, `${group}.${field}`)
    }
  }
})

it('buildSchemaStatements emits idempotent DDL for every v5 table', () => {
  const statements = buildSchemaStatements()
  const joined = statements.join('\n')
  assertEquals(
    statements.every(
      (sql) =>
        sql.startsWith('CREATE TABLE IF NOT EXISTS') || sql.startsWith('CREATE INDEX IF NOT EXISTS')
    ),
    true
  )
  for (const table of [
    HOST_SAMPLES_TABLE,
    NETWORK_SAMPLES_TABLE,
    FILESYSTEM_SAMPLES_TABLE,
    BLOCK_SAMPLES_TABLE,
    GPU_SAMPLES_TABLE,
    MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
    HARDWARE_SIGNAL_SAMPLES_TABLE,
    INGRESS_SAMPLES_TABLE,
    DATABASE_PROXY_SAMPLES_TABLE,
    STORAGE_SAMPLES_TABLE,
    DOCKER_SAMPLES_TABLE,
    METRIC_EVENTS_TABLE,
    STATUS_EVENTS_TABLE,
  ]) {
    assertEquals(joined.includes(`CREATE TABLE IF NOT EXISTS ${table}`), true, table)
    assertEquals(joined.includes(`ON ${table} (server_id, `), true, table)
  }
  // No positional AE layout ever leaks into DuckDB.
  assertEquals(/\bdouble\d+\b/.test(joined), false)
  assertEquals(/\bblob\d+\b/.test(joined), false)
  assertEquals(joined.includes('index1'), false)
  // No v3 marker columns survive the cutover.
  assertEquals(joined.includes(' parts '), false)
  assertEquals(joined.includes('hardware_profile_generation'), false)
  // v5-only common metadata columns present on every family table.
  assertEquals(joined.includes('topology_generation INTEGER NOT NULL'), true)
  assertEquals(joined.includes('boot_generation INTEGER NOT NULL'), true)
  assertEquals(joined.includes('sequence BIGINT NOT NULL'), true)
  // Per-entity index shape.
  assertEquals(
    joined.includes(`ON ${NETWORK_SAMPLES_TABLE} (server_id, device_id, sampled_at)`),
    true
  )
  assertEquals(joined.includes(`ON ${GPU_SAMPLES_TABLE} (server_id, gpu_id, sampled_at)`), true)
  assertEquals(joined.includes(`ON ${METRIC_EVENTS_TABLE} (server_id, "at")`), true)
  assertEquals(joined.includes(`ON ${STATUS_EVENTS_TABLE} (server_id, "at")`), true)
  // Every host metric key gets a nullable DOUBLE column.
  for (const ref of HOST_METRIC_FIELD_REFS) {
    assertEquals(
      joined.includes(`${hostMetricColumnName(ref.group, ref.field)} DOUBLE`),
      true,
      `${ref.group}.${ref.field}`
    )
  }
  // Long-form hardware-signal table: kind + value, not one column per signal kind.
  assertEquals(joined.includes('kind VARCHAR NOT NULL'), true)
  assertEquals(joined.includes('value DOUBLE'), true)
  // Hand-declared diagnostics CPU-half host-global columns land on server_host_samples.
  assertEquals(joined.includes('cpu_diagnostics_average_frequency_m_hz DOUBLE'), true)
  assertEquals(joined.includes('cpu_diagnostics_cpu_irq_percent DOUBLE'), true)
  for (const field of MEMORY_DIAGNOSTICS_METRIC_FIELDS) {
    assertEquals(
      joined.includes(`${entityMetricColumnName(field)} DOUBLE`),
      true,
      `diagnostics.${field}`
    )
  }
  // v6 dropped the sample-level collection-mode column outright.
  assertEquals(joined.includes('collection_mode'), false)
  // The seven meminfo gauges v6 dropped have no column anywhere.
  for (
    const dropped of [
      'page_tables_bytes',
      'kernel_stack_bytes',
      'commit_limit_bytes',
      'active_anon_bytes',
      'inactive_anon_bytes',
      'active_file_bytes',
      'inactive_file_bytes',
    ]
  ) {
    assertEquals(joined.includes(dropped), false, dropped)
  }
})

it('memoryDiagnosticsSamplesInsertColumns is a singleton (no entity id column), 12 fields', () => {
  const columns = memoryDiagnosticsSamplesInsertColumns()
  assertEquals(MEMORY_DIAGNOSTICS_METRIC_FIELDS.length, 12)
  assertEquals(columns.length, 7 + MEMORY_DIAGNOSTICS_METRIC_FIELDS.length)
  assertEquals(columns.includes('core_id'), false)
  assertEquals(columns.includes('memory_free_bytes'), true)
  assertEquals(columns.includes('compaction_stalls_per_second'), true)
})

it('hostSamplesInsertColumns lists common metadata then every host metric column plus the hand-declared diagnostics CPU host-global columns', () => {
  const columns = hostSamplesInsertColumns()
  assertEquals(
    columns.length,
    7 + HOST_METRIC_FIELD_REFS.length + HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST.length
  )
  assertEquals(columns.slice(0, 7), [
    'server_id',
    'sampled_at',
    'received_at',
    'interval_seconds',
    'sequence',
    'topology_generation',
    'boot_generation',
  ])
  assertEquals(columns.includes('cpu_busy_percent'), true)
  assertEquals(columns.includes('cpu_process_count'), true)
  assertEquals(columns.includes('memory_pressure_some_percent'), true)
  assertEquals(columns.includes('cpu_diagnostics_average_frequency_m_hz'), true)
  assertEquals(columns.includes('cpu_diagnostics_cpu_irq_percent'), true)
})

it('every entity family declares a non-empty, unique field list', () => {
  for (const fields of [
    NETWORK_METRIC_FIELDS,
    FILESYSTEM_METRIC_FIELDS,
    BLOCK_METRIC_FIELDS,
    GPU_METRIC_FIELDS,
    INGRESS_METRIC_FIELDS,
    DATABASE_PROXY_METRIC_FIELDS,
  ]) {
    assertEquals(fields.length > 0, true)
    assertEquals(new Set(fields).size, fields.length)
  }
})

// ---------------------------------------------------------------------------
// managed.storage / managed.docker — the two v6 host-wide storage tables.
// ---------------------------------------------------------------------------

it('server_storage_samples carries the storage row plus a docker_-prefixed breakdown copy', () => {
  const columns = storageSamplesMetricColumnNames()
  // The flat storage fields, snake_cased from their contract names.
  for (
    const column of [
      'hosting_used_bytes',
      'backup_used_bytes',
      'docker_used_bytes',
      'logs_used_bytes',
      'hosting_free_bytes',
      'backup_free_bytes',
      'logs_free_bytes',
    ]
  ) {
    assertEquals(columns.includes(column), true, column)
  }
  // The Docker breakdown, prefixed so it cannot collide with the total.
  assertEquals(columns.includes('docker_layers_bytes'), true)
  assertEquals(columns.includes('docker_build_cache_reclaimable_bytes'), true)
  // The twelve per-engine census columns, flattened `<engine><Field>`.
  assertEquals(columns.includes('postgres_instances_running'), true)
  assertEquals(columns.includes('mariadb_connections_max'), true)
  assertEquals(STORAGE_ENGINE_METRIC_FIELDS.length, 12)
  // No duplicate column names in the single wide table.
  assertEquals(new Set(columns).size, columns.length)
})

it('storageSamplesInsertColumns is metadata + metrics + the four nullable topology id columns', () => {
  const columns = storageSamplesInsertColumns()
  assertEquals(
    columns.slice(-STORAGE_FILESYSTEM_ID_COLUMNS.length),
    [...STORAGE_FILESYSTEM_ID_COLUMNS]
  )
  assertEquals(
    columns.length,
    COMMON_METADATA_COLUMNS.length +
      storageSamplesMetricColumnNames().length +
      STORAGE_FILESYSTEM_ID_COLUMNS.length
  )
})

it('server_docker_samples mirrors the AE managed.docker family exactly, unprefixed', () => {
  const columns = dockerSamplesInsertColumns()
  assertEquals(
    columns.slice(COMMON_METADATA_COLUMNS.length),
    DOCKER_USAGE_METRIC_FIELDS.map(entityMetricColumnName)
  )
  assertEquals(DOCKER_USAGE_METRIC_FIELDS.length, 10)
  assertEquals(columns.includes('layers_bytes'), true)
  assertEquals(columns.includes('docker_layers_bytes'), false)
})

it('dockerUsageStorageColumnName rejects a field outside the Docker breakdown', () => {
  assertEquals(dockerUsageStorageColumnName('layersBytes'), 'docker_layers_bytes')
  assertThrows(
    () => dockerUsageStorageColumnName('nope'),
    TypeError,
    'unknown Docker usage field'
  )
})

it('the storage and docker tables carry no entity id column, like the router table', () => {
  const joined = buildSchemaStatements().join('\n')
  const storageDdl = joined.slice(
    joined.indexOf(`CREATE TABLE IF NOT EXISTS ${STORAGE_SAMPLES_TABLE}`)
  )
  assertEquals(storageDdl.includes('source_id'), false)
  const dockerDdl = joined.slice(
    joined.indexOf(`CREATE TABLE IF NOT EXISTS ${DOCKER_SAMPLES_TABLE}`),
    joined.indexOf(`CREATE INDEX IF NOT EXISTS idx_${DOCKER_SAMPLES_TABLE}`)
  )
  assertEquals(dockerDdl.includes('source_id'), false)
  assertEquals(dockerDdl.includes('gpu_id'), false)
})
