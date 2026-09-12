/**
 * Deno DuckDB + Parquet metrics store for the v5 contract.
 *
 * One typed table per entity family (`schema.ts`) with real named columns
 * and real SQL `NULL`s for missing metrics — no AE sentinel, no positional
 * `doubleN`/`blobN` layout, no v3 `parts` marker (v5 has no `MetricPart`
 * allowlist: a family simply has no row for a sample that never reported
 * it). Recent rows live in the hot DuckDB tables; completed UTC days are
 * sealed per family into immutable Parquet partitions (`parquet.ts`).
 *
 * Implements the full v5 contract (`ServerMetricsStore`): ingest write
 * path, `queryHostSeries`/`queryHostSummary`/`queryFleetHostSnapshot` over
 * any `host.*`/`diagnostics.*` canonical metric name, and
 * `queryStatusHistory`.
 *
 * Fail clearly when configured-but-unavailable: DuckDB/filesystem failures
 * propagate as thrown errors. Writes are batched in-process (row count +
 * age) and stay fire-and-forget at the ingest boundary.
 */

import {
  DIAGNOSTICS_CPU_FIELD_NAMES,
  HOST_METRICS_METRIC_DESCRIPTORS,
  type HostMetricsMetricDescriptor,
  type MetricEntityScope,
} from '../../metric-descriptors.ts'
import type { MetricEventKind, MetricEventSeverity, MetricEvent } from '../../contract.ts'
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  MAX_STATUS_EVENTS,
  resolveTruncatedStatusEvents,
} from '../cloudflare/sql-api.ts'
import {
  computeSeriesGapCount,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResult,
} from '../../query/series-response.ts'
import { computeStatusUptime } from '../../query/uptime.ts'
import type {
  AuthenticatedMetricsSample,
  EntityIdsSeenQuery,
  EntityIdsSeenResult,
  EntitySeriesEntityResult,
  EntitySeriesPoint,
  EntitySeriesQuery,
  EntitySeriesResult,
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  FleetHostSnapshotServer,
  HostSeriesPoint,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  MetricEventsQuery,
  MetricEventsResult,
  PerEntityHostedFamily,
  ServerMetricsStore,
  ServerStatusEvent,
  SlotMapping,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../types.ts'
import {
  type DuckDbBindValue,
  type DuckDbConnectionLike,
  type DuckDbHandle,
  type DuckDbPaths,
  type DuckDbRow,
  escapeSqlString,
  openDuckDb,
  resolveDuckDbPaths,
} from './database.ts'
import {
  cleanupTmpParquetFiles,
  listPartitionFilesInRange,
  MS_PER_DAY,
  PARQUET_FAMILIES,
  type ParquetFamily,
  parquetFamily,
  type ParquetFamilyKey,
  pruneExpiredPartitions,
  sealDayToParquet,
  timestampLiteralFromMs,
  utcDayStartMs,
} from './parquet.ts'
import {
  BLOCK_METRIC_FIELDS,
  BLOCK_SAMPLES_TABLE,
  blockSamplesInsertColumns,
  cpuDiagnosticsHostColumnName,
  DATABASE_PROXY_METRIC_FIELDS,
  DATABASE_PROXY_SAMPLES_TABLE,
  databaseProxySamplesInsertColumns,
  entityMetricColumnName,
  FILESYSTEM_METRIC_FIELDS,
  FILESYSTEM_SAMPLES_TABLE,
  filesystemSamplesInsertColumns,
  GPU_METRIC_FIELDS,
  GPU_SAMPLES_TABLE,
  gpuSamplesInsertColumns,
  HARDWARE_SIGNAL_SAMPLES_TABLE,
  hardwareSignalSamplesInsertColumns,
  HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST,
  HOST_METRIC_FIELD_REFS,
  HOST_SAMPLES_TABLE,
  hostMetricColumnName,
  type HostMetricGroup,
  hostSamplesInsertColumns,
  INGRESS_METRIC_FIELDS,
  INGRESS_SAMPLES_TABLE,
  ingressSamplesInsertColumns,
  MEMORY_DIAGNOSTICS_METRIC_FIELDS,
  MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
  memoryDiagnosticsSamplesInsertColumns,
  METRIC_EVENTS_TABLE,
  metricEventsInsertColumns,
  NETWORK_METRIC_FIELDS,
  NETWORK_SAMPLES_TABLE,
  networkSamplesInsertColumns,
  DOCKER_SAMPLES_TABLE,
  dockerSamplesInsertColumns,
  DOCKER_USAGE_METRIC_FIELDS,
  ROUTER_METRIC_FIELDS,
  ROUTER_SAMPLES_TABLE,
  routerSamplesInsertColumns,
  STATUS_EVENTS_TABLE,
  STORAGE_FILESYSTEM_ID_COLUMNS,
  STORAGE_ROW_VALUE_PLAN,
  STORAGE_SAMPLES_TABLE,
  storageSamplesInsertColumns,
  storageSamplesMetricColumnNames,
} from './schema.ts'
import { STORAGE_ENGINE_FIELD_NAMES, STORAGE_ENGINE_KEYS } from '../../contract.ts'

/** Flush when this many pending rows accumulate (small co-located fleet). */
export const DUCKDB_WRITE_BATCH_MAX_ROWS = 10

/**
 * Max age before an incomplete batch flushes. Short on purpose: loaded
 * instances flush via the row-count path, while sparse traffic (a single
 * sample every ~60 s) must still persist promptly — an accepted row never
 * sits in memory for more than a few seconds.
 */
export const DUCKDB_WRITE_BATCH_MAX_AGE_MS = 5_000

/** Default retention for hot rows + sealed partitions (matches AE's 90 days). */
export const DEFAULT_DUCKDB_RETENTION_DAYS = 90

/** Loopback port the dev-only embedded DuckDB UI serves on. */
export const DUCKDB_UI_DEFAULT_PORT = 4213

/** How often the armed daily-archive timer checks for a completed UTC day. */
export const DUCKDB_ARCHIVE_CHECK_INTERVAL_MS = 60 * 60_000

/** Default bucket when `resolutionSeconds` is omitted (5 minutes). */
export const DUCKDB_DEFAULT_BUCKET_SECONDS = 300

/** Cap on serverIds accepted into one fleet snapshot IN-list. */
export const DUCKDB_MAX_FLEET_SNAPSHOT_SERVERS = 500

export type DuckDbStoreConfig = {
  /** Metrics state root override (default: `resolveMetricsDir()`). */
  metricsDir?: string
  /** DuckDB worker-thread cap (`SET threads`, default 2). */
  threads?: number
  /** DuckDB memory cap in MiB (`SET memory_limit`, default 128). */
  memoryLimitMb?: number
  /** Hot + Parquet retention days (default 90). */
  retentionDays?: number
}

export type DuckDbStoreOptions = {
  /** Injected handle factory (tests) — skips filesystem setup + native open. */
  openHandle?: () => Promise<DuckDbHandle>
  /** Override insert batch size (default {@link DUCKDB_WRITE_BATCH_MAX_ROWS}). */
  writeBatchMaxRows?: number
  /** Override insert batch age (default {@link DUCKDB_WRITE_BATCH_MAX_AGE_MS}). */
  writeBatchMaxAgeMs?: number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  now?: () => number
  onFlushError?: (error: unknown) => void
}

type PendingRowTable =
  | 'host'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'gpu'
  | 'memoryDiagnostics'
  | 'hardwareSignal'
  | 'ingress'
  | 'databaseProxy'
  | 'router'
  | 'storage'
  | 'docker'
  | 'event'
  | 'status'

type PendingRow = { table: PendingRowTable; values: DuckDbBindValue[] }

export class DuckDbParquetServerMetricsStore implements ServerMetricsStore {
  readonly #paths: DuckDbPaths
  readonly #threads: number | undefined
  readonly #memoryLimitMb: number | undefined
  readonly #retentionDays: number
  readonly #openHandle: () => Promise<DuckDbHandle>
  readonly #batchMaxRows: number
  readonly #batchMaxAgeMs: number
  readonly #setTimeout: typeof setTimeout
  readonly #clearTimeout: typeof clearTimeout
  readonly #setInterval: typeof setInterval
  readonly #clearInterval: typeof clearInterval
  readonly #now: () => number
  readonly #onFlushError: (error: unknown) => void
  #handle: DuckDbHandle | null = null
  #openPromise: Promise<DuckDbHandle> | null = null
  readonly #pendingRows: PendingRow[] = []
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #flushPromise: Promise<void> | null = null
  #archiveTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: DuckDbStoreConfig = {}, options?: DuckDbStoreOptions) {
    this.#threads = assertOptionalPositiveInt('threads', config.threads)
    this.#memoryLimitMb = assertOptionalPositiveInt('memoryLimitMb', config.memoryLimitMb)
    this.#retentionDays =
      assertOptionalPositiveInt('retentionDays', config.retentionDays) ??
      DEFAULT_DUCKDB_RETENTION_DAYS
    this.#paths = resolveDuckDbPaths(config.metricsDir)
    this.#batchMaxRows = options?.writeBatchMaxRows ?? DUCKDB_WRITE_BATCH_MAX_ROWS
    this.#batchMaxAgeMs = options?.writeBatchMaxAgeMs ?? DUCKDB_WRITE_BATCH_MAX_AGE_MS
    this.#setTimeout = options?.setTimeoutFn ?? setTimeout
    this.#clearTimeout = options?.clearTimeoutFn ?? clearTimeout
    this.#setInterval = options?.setIntervalFn ?? setInterval
    this.#clearInterval = options?.clearIntervalFn ?? clearInterval
    this.#now = options?.now ?? Date.now
    this.#onFlushError = options?.onFlushError ?? defaultFlushErrorLog
    if (options?.openHandle) {
      this.#openHandle = options.openHandle
    } else {
      // Fail at construction (not first query) when the metrics directory
      // cannot be created — store selection catches this and falls back to
      // the disabled store.
      Deno.mkdirSync(this.#paths.metricsDir, { recursive: true })
      Deno.mkdirSync(this.#paths.parquetRoot, { recursive: true })
      Deno.mkdirSync(this.#paths.tmpDir, { recursive: true })
      this.#openHandle = () =>
        openDuckDb({
          paths: this.#paths,
          ...(this.#threads !== undefined ? { threads: this.#threads } : {}),
          ...(this.#memoryLimitMb !== undefined ? { memoryLimitMb: this.#memoryLimitMb } : {}),
        })
    }
  }

  /** Resolved on-disk layout (db file, parquet tree, tmp spill). */
  get paths(): DuckDbPaths {
    return this.#paths
  }

  /**
   * Dev-only: serve the DuckDB UI from this store's embedded instance
   * (`INSTALL ui; LOAD ui; CALL start_ui_server()`), so the browser attaches
   * to the single writer instead of a second process opening the database
   * file. Idempotent — `start_ui_server()` is a no-op when already running.
   */
  async startUiServer(port: number = DUCKDB_UI_DEFAULT_PORT): Promise<{ port: number }> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new TypeError('port must be a valid TCP port')
    }
    const handle = await this.#ensureOpen()
    await handle.connection.run(`SET ui_local_port = ${port}`)
    await handle.connection.run('INSTALL ui')
    await handle.connection.run('LOAD ui')
    await handle.connection.run('CALL start_ui_server()')
    return { port }
  }

  /**
   * Fire-and-forget insert (batched). Fans one sample into a `host` row, one
   * row per entity in `networks`/`filesystems`/`blockDevices`/`gpus`/
   * `hardwareSignals`/`ingressSources`/`databaseProxies`, one singleton row
   * each for the presence-gated `diagnostics` memory half, `router`,
   * `storage` and `dockerUsage`, and
   * one row per `events` entry — all enqueued together so `#flushPending` commits the
   * entire fan-out for one sample in a single transaction (never split
   * across two batches). `slotMapping` is accepted to satisfy
   * `ServerMetricsStore` but not consulted: DuckDB has no page/slot
   * concept to resolve identity against.
   */
  writeSample(input: AuthenticatedMetricsSample, _slotMapping?: SlotMapping): Promise<void> {
    const common: DuckDbBindValue[] = [
      input.serverId,
      toDuckDbTimestamp(input.metadata.sampledAt),
      toDuckDbTimestamp(input.receivedAt),
      Math.round(input.metadata.intervalSeconds),
      input.metadata.sequence,
      input.metadata.topologyGeneration,
      input.metadata.bootGeneration,
    ]
    const rows: PendingRow[] = []

    rows.push({
      table: 'host',
      values: [
        ...common,
        ...HOST_METRIC_FIELD_REFS.map((ref) => numericField(input.host[ref.group], ref.field)),
        ...HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST.map((field) =>
          input.diagnostics ? numericField(input.diagnostics.cpu, field) : null
        ),
      ],
    })

    if (input.diagnostics) {
      const diagnosticsMemory = input.diagnostics.memory
      rows.push({
        table: 'memoryDiagnostics',
        values: [
          ...common,
          ...MEMORY_DIAGNOSTICS_METRIC_FIELDS.map((field) =>
            numericField(diagnosticsMemory, field)
          ),
        ],
      })
    }

    for (const network of input.networks) {
      rows.push({
        table: 'network',
        values: [
          ...common,
          network.deviceId,
          ...NETWORK_METRIC_FIELDS.map((field) => numericField(network, field)),
        ],
      })
    }

    for (const filesystem of input.filesystems) {
      rows.push({
        table: 'filesystem',
        values: [
          ...common,
          filesystem.filesystemId,
          ...FILESYSTEM_METRIC_FIELDS.map((field) => numericField(filesystem, field)),
        ],
      })
    }

    for (const device of input.blockDevices) {
      rows.push({
        table: 'block',
        values: [
          ...common,
          device.deviceId,
          ...BLOCK_METRIC_FIELDS.map((field) => numericField(device, field)),
        ],
      })
    }

    for (const gpu of input.gpus) {
      rows.push({
        table: 'gpu',
        values: [
          ...common,
          gpu.gpuId,
          ...GPU_METRIC_FIELDS.map((field) => numericField(gpu, field)),
        ],
      })
    }

    for (const signal of input.hardwareSignals) {
      rows.push({
        table: 'hardwareSignal',
        values: [...common, signal.signalId, signal.kind, signal.value ?? null],
      })
    }

    for (const ingress of input.ingressSources) {
      rows.push({
        table: 'ingress',
        values: [
          ...common,
          ingress.sourceId,
          ingress.sourceKind,
          ...INGRESS_METRIC_FIELDS.map((field) => numericField(ingress, field)),
        ],
      })
    }

    for (const proxy of input.databaseProxies) {
      rows.push({
        table: 'databaseProxy',
        values: [
          ...common,
          proxy.sourceId,
          proxy.sourceKind,
          ...DATABASE_PROXY_METRIC_FIELDS.map((field) => numericField(proxy, field)),
        ],
      })
    }

    if (input.router) {
      const router = input.router
      rows.push({
        table: 'router',
        values: [
          ...common,
          ...ROUTER_METRIC_FIELDS.map((field) => numericField(router, field)),
        ],
      })
    }

    if (input.storage) {
      const storage = input.storage
      const dockerUsage = input.dockerUsage
      rows.push({
        table: 'storage',
        values: [
          ...common,
          ...STORAGE_ROW_VALUE_PLAN.leadingFlatFields.map((field) =>
            numericField(storage, field)
          ),
          // Real SQL NULLs when the Docker breakdown was absent or gated off
          // — "not reported", never zero bytes.
          ...DOCKER_USAGE_METRIC_FIELDS.map((field) =>
            dockerUsage ? numericField(dockerUsage, field) : null
          ),
          ...STORAGE_ROW_VALUE_PLAN.trailingFlatFields.map((field) =>
            numericField(storage, field)
          ),
          ...STORAGE_ENGINE_KEYS.flatMap((engine) =>
            STORAGE_ENGINE_FIELD_NAMES.map((field) =>
              numericField(storage[engine], field)
            )
          ),
          // Topology filesystem ids: nothing on the wire carries them yet —
          // see `STORAGE_FILESYSTEM_ID_COLUMNS` in `schema.ts`.
          null,
          null,
          null,
          null,
        ],
      })
    }

    if (input.dockerUsage) {
      const dockerUsage = input.dockerUsage
      rows.push({
        table: 'docker',
        values: [
          ...common,
          ...DOCKER_USAGE_METRIC_FIELDS.map((field) => numericField(dockerUsage, field)),
        ],
      })
    }

    for (const event of input.events) {
      rows.push({
        table: 'event',
        values: [
          input.serverId,
          event.eventId,
          toDuckDbTimestamp(event.at),
          toDuckDbTimestamp(input.receivedAt),
          event.kind,
          event.severity,
          input.metadata.topologyGeneration,
          event.entityId ?? null,
          event.source ?? null,
          event.payload ? JSON.stringify(event.payload) : null,
        ],
      })
    }

    return this.#enqueueRows(rows)
  }

  /**
   * Fire-and-forget status transition — batched onto the same pending buffer
   * / flush timer as metric samples, but inserted into its own typed table.
   */
  writeStatusEvent(input: ServerStatusEvent): Promise<void> {
    return this.#enqueueRows([
      {
        table: 'status',
        values: [input.serverId, toDuckDbTimestamp(input.at), input.connected, input.reason],
      },
    ])
  }

  /** Force-flush pending writes (queries / shutdown / archive tick). */
  flushWrites(): Promise<void> {
    return this.#flushPending({ rethrow: true })
  }

  async queryStatusHistory(input: StatusHistoryQuery): Promise<StatusHistoryResult> {
    await this.flushWrites()
    const serverId = assertSafeServerId(input.serverId)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)

    const handle = await this.#ensureOpen()
    // Aliases match `resolveTruncatedStatusEvents` row expectations
    // (`timestamp` epoch-ms, `connected`, `reason`).
    const selectList = [
      `  CAST(epoch_ms("at") AS DOUBLE) AS "timestamp",`,
      `  connected,`,
      `  reason`,
    ].join('\n')
    const priorSql = [
      'SELECT',
      selectList,
      `FROM ${STATUS_EVENTS_TABLE}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND "at" < CAST(? AS TIMESTAMP)`,
      `ORDER BY "at" DESC`,
      `LIMIT 1`,
    ].join('\n')
    const eventsSql = [
      'SELECT',
      selectList,
      `FROM ${STATUS_EVENTS_TABLE}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND "at" >= CAST(? AS TIMESTAMP)`,
      `  AND "at" < CAST(? AS TIMESTAMP)`,
      `ORDER BY "at" ASC`,
      `LIMIT ${MAX_STATUS_EVENTS + 1}`,
    ].join('\n')

    // Sequential on purpose — a DuckDB connection is not safe for
    // concurrent statements.
    const fromParam = toDuckDbTimestamp(from.toISOString())
    const toParam = toDuckDbTimestamp(to.toISOString())
    const priorReader = await handle.connection.runAndReadAll(priorSql, [serverId, fromParam])
    const eventsReader = await handle.connection.runAndReadAll(eventsSql, [
      serverId,
      fromParam,
      toParam,
    ])

    const priorConnected = parseStatusConnected(priorReader.getRowObjectsJS()[0]?.connected)
    const fromMs = from.getTime()
    const toMs = to.getTime()
    const { events, truncated, knownUntilMs } = resolveTruncatedStatusEvents(
      eventsReader.getRowObjectsJS(),
      fromMs
    )
    const uptime = computeStatusUptime({
      fromMs,
      toMs,
      initialConnected: priorConnected,
      events,
      knownUntilMs,
    })

    return {
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      initialConnected: priorConnected,
      events,
      uptimeSeconds: uptime.uptimeSeconds,
      downtimeSeconds: uptime.downtimeSeconds,
      unknownSeconds: uptime.unknownSeconds,
      uptimePercent: uptime.uptimePercent,
      truncated,
    }
  }

  /**
   * Real per-descriptor aggregation (`HOST_METRICS_METRIC_DESCRIPTORS`)
   * over any `host.*` canonical metric name. Also accepts `diagnostics.*`
   * and `router.*` / `storage.*` / `dockerUsage.*` canonical names
   * (host-singleton scalars, same as `host.*`) — each reads its own singleton
   * table (`server_router_samples` / `server_storage_samples` /
   * `server_docker_samples`) through an additional `(server_id, sampled_at)`
   * left join, exactly like the memory-diagnostics half, and resolves to a
   * real SQL `NULL` for any sample where that family did not report. The merged
   * v6 diagnostics family is split across two tables by which half a field
   * belongs to, so routing is by field membership rather than by scope: its 7
   * CPU fields live on the host row itself (`cpu_diagnostics_*` columns) and
   * need no join, while its 12 memory fields live in the singleton
   * `server_memory_diagnostics_samples` table, left-joined on
   * `(server_id, sampled_at)` — every sample writes its host and
   * memory-diagnostics rows with the identical pair, so the join is exact,
   * never fan-out. v6 has no per-core rehydration: the busiest-core hotspot
   * family the CPU scalars used to accompany no longer exists.
   */
  async queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    await this.flushWrites()
    const serverId = assertSafeServerId(input.serverId)
    const metrics = assertHostMetrics(input.metrics, HOST_SERIES_EXTRA_SCOPES)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)
    const bucketSeconds = assertPositiveInt(
      'resolutionSeconds',
      input.resolutionSeconds ?? DUCKDB_DEFAULT_BUCKET_SECONDS
    )

    const handle = await this.#ensureOpen()
    const fromMs = from.getTime()
    const toMs = to.getTime()
    const hostSource = await this.#familySamplesSource(parquetFamily('host'), fromMs, toMs)
    const requiresMemoryDiagnostics = metrics.some(isMemoryDiagnosticsMetric)
    const requiresCpuDiagnostics = metrics.some(isCpuDiagnosticsMetric)
    const requiresRouter = metrics.some(isRouterMetric)
    const requiresStorage = metrics.some(isStorageMetric)
    const requiresDockerUsage = metrics.some(isDockerUsageMetric)

    const joins: string[] = []
    if (requiresMemoryDiagnostics) {
      const memoryDiagnosticsSource = await this.#familySamplesSource(
        parquetFamily('memory-diagnostics'),
        fromMs,
        toMs
      )
      joins.push(
        `LEFT JOIN ${memoryDiagnosticsSource} AS md ON md.server_id = h.server_id AND md.sampled_at = h.sampled_at`
      )
    }
    if (requiresRouter) {
      const routerSource = await this.#familySamplesSource(
        parquetFamily('router'),
        fromMs,
        toMs
      )
      joins.push(
        `LEFT JOIN ${routerSource} AS rt ON rt.server_id = h.server_id AND rt.sampled_at = h.sampled_at`
      )
    }
    if (requiresStorage) {
      const storageSource = await this.#familySamplesSource(
        parquetFamily('storage'),
        fromMs,
        toMs
      )
      joins.push(
        `LEFT JOIN ${storageSource} AS st ON st.server_id = h.server_id AND st.sampled_at = h.sampled_at`
      )
    }
    if (requiresDockerUsage) {
      const dockerSource = await this.#familySamplesSource(
        parquetFamily('docker'),
        fromMs,
        toMs
      )
      joins.push(
        `LEFT JOIN ${dockerSource} AS dk ON dk.server_id = h.server_id AND dk.sampled_at = h.sampled_at`
      )
    }

    const metricSelects = metrics.map((name) => {
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[name]!
      const column = hostSeriesColumnForDescriptor(descriptor)
      // "h." metadata prefix: unambiguous even without the `md`/`rt`/`st`/`dk` joins,
      // and required whenever either is present (every singleton table
      // carries `sampled_at`/`interval_seconds` of its own).
      return `${hostFieldAggregateSql(descriptor, column, 'h.')} AS "${name}"`
    })
    const sql = [
      'SELECT',
      `  CAST((epoch_ms(h.sampled_at) // ${
        bucketSeconds * 1000
      }) * ${bucketSeconds} AS DOUBLE) AS bucket,`,
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  CAST(avg(h.interval_seconds) AS DOUBLE) AS avg_interval_seconds,`,
      `  string_agg(DISTINCT CAST(h.topology_generation AS VARCHAR), ',') AS topology_gen_raw,`,
      ...(requiresCpuDiagnostics
        ? [`  CAST(epoch_ms(max(h.sampled_at)) AS DOUBLE) AS last_sampled_at_ms,`]
        : []),
      `  ${metricSelects.join(',\n  ')}`,
      `FROM ${hostSource} AS h`,
      ...joins,
      `WHERE h.server_id = CAST(? AS UUID)`,
      `  AND h.sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND h.sampled_at < CAST(? AS TIMESTAMP)`,
      `GROUP BY bucket`,
      `ORDER BY bucket ASC`,
    ].join('\n')

    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ])
    const rows = reader.getRowObjectsJS()

    const { points, sampleCount, topologyGenerations } = parseHostSeriesRows(
      metrics,
      rows,
      bucketSeconds
    )

    return finalizeHostSeriesResult(from.toISOString(), to.toISOString(), {
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      metrics,
      points,
      resolutionSeconds: bucketSeconds,
      gapCount: 0,
      sampleCount,
      topologyGenerations,
    })
  }

  async queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult> {
    await this.flushWrites()
    const serverId = assertSafeServerId(input.serverId)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)

    const handle = await this.#ensureOpen()
    const source = await this.#hostSamplesSource(from.getTime(), to.getTime())
    const sql = [
      'SELECT',
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  CAST(epoch_ms(max(sampled_at)) AS DOUBLE) AS latest_at_ms`,
      `FROM ${source}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
    ].join('\n')
    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ])
    const row = reader.getRowObjectsJS()[0]
    const sampleCount = toFiniteNumber(row?.sample_count) ?? 0
    const latestAtMs = toFiniteNumber(row?.latest_at_ms)

    return {
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      sampleCount,
      latestAt: sampleCount > 0 && latestAtMs !== null ? new Date(latestAtMs).toISOString() : null,
    }
  }

  /**
   * Real per-descriptor aggregation over any `host.*` canonical metric name.
   */
  async queryFleetHostSnapshot(
    input: FleetHostSnapshotQuery
  ): Promise<FleetHostSnapshotResult> {
    if (input.serverIds.length === 0) {
      return {
        kind: 'duckdb',
        available: true,
        metrics: [...input.metrics],
        servers: [],
      }
    }
    await this.flushWrites()
    const metrics = assertHostMetrics(input.metrics)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)
    const serverIds = dedupeServerIds(input.serverIds)

    const handle = await this.#ensureOpen()
    const source = await this.#familySamplesSource(
      parquetFamily('host'),
      from.getTime(),
      to.getTime()
    )
    const metricSelects = metrics.map((name) => {
      const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[name]!
      const column = hostColumnForDescriptor(descriptor)
      return `${hostFieldAggregateSql(descriptor, column)} AS "${name}"`
    })
    const inList = serverIds.map(() => 'CAST(? AS UUID)').join(', ')
    const sql = [
      'SELECT',
      `  CAST(server_id AS VARCHAR) AS server_id,`,
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  CAST(epoch_ms(max(sampled_at)) AS DOUBLE) AS latest_at_ms,`,
      `  string_agg(DISTINCT CAST(topology_generation AS VARCHAR), ',') AS topology_gen_raw,`,
      `  ${metricSelects.join(',\n  ')}`,
      `FROM ${source}`,
      `WHERE server_id IN (${inList})`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
      `GROUP BY server_id`,
    ].join('\n')
    const reader = await handle.connection.runAndReadAll(sql, [
      ...serverIds,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ])

    const servers: FleetHostSnapshotServer[] = []
    for (const row of reader.getRowObjectsJS()) {
      const serverId = typeof row.server_id === 'string' ? row.server_id.trim() : ''
      if (!serverId) continue
      const sampleCount = toFiniteNumber(row.sample_count) ?? 0
      const latestAtMs = toFiniteNumber(row.latest_at_ms)
      const generations = parseHardwareProfileGenerations(row.topology_gen_raw)
      servers.push({
        serverId,
        sampleCount,
        latestAt:
          latestAtMs === null || sampleCount <= 0 ? null : new Date(latestAtMs).toISOString(),
        values: parseMetricValues(metrics, row),
        topologyGeneration: generations.length === 1 ? generations[0]! : null,
      })
    }
    servers.sort((a, b) => a.serverId.localeCompare(b.serverId))

    return { kind: 'duckdb', available: true, metrics, servers }
  }

  /**
   * Arm the periodic daily-archive check. Not auto-started by the
   * constructor — the boot path (`deno-server.ts`) calls this once so tests
   * can drive archiving deterministically via {@link runDailyArchiveOnce}.
   */
  startDailyArchiveTimer(): void {
    if (this.#archiveTimer !== null) return
    const tick = () => {
      void this.runDailyArchiveOnce().catch((error) => {
        this.#onFlushError(error)
      })
    }
    this.#archiveTimer = this.#setInterval(tick, DUCKDB_ARCHIVE_CHECK_INTERVAL_MS)
    // Immediate first pass: sweep crash leftovers + seal any backlog days.
    tick()
  }

  stopDailyArchiveTimer(): void {
    if (this.#archiveTimer === null) return
    this.#clearInterval(this.#archiveTimer)
    this.#archiveTimer = null
  }

  /**
   * One archive pass: sweep interrupted exports, seal every completed UTC
   * day still hot in every family table, then apply retention to partitions
   * and rows across every family (plus `server_status_events`).
   */
  async runDailyArchiveOnce(nowMs: number = this.#now()): Promise<void> {
    const handle = await this.#ensureOpen()
    await this.flushWrites()
    // An interrupted export never counts as sealed — its hot rows are still
    // in the hot table, so deleting the leftover cannot double-delete.
    await cleanupTmpParquetFiles(this.#paths.tmpDir)

    const todayStartMs = utcDayStartMs(nowMs)
    for (const family of PARQUET_FAMILIES) {
      const reader = await handle.connection.runAndReadAll(
        `SELECT DISTINCT CAST(epoch_ms(${family.timestampColumn}) // ${MS_PER_DAY} AS DOUBLE) AS day ` +
          `FROM ${family.table} ` +
          `WHERE ${family.timestampColumn} < ${timestampLiteralFromMs(todayStartMs)}`
      )
      const days = reader
        .getRowObjectsJS()
        .map((row) => toFiniteNumber(row.day))
        .filter((day): day is number => day !== null)
        .sort((a, b) => a - b)
      for (const day of days) {
        const dayStartMs = day * MS_PER_DAY
        await sealDayToParquet(handle.connection, {
          family,
          dayStartMs,
          dayEndMs: dayStartMs + MS_PER_DAY,
          parquetRoot: this.#paths.parquetRoot,
          tmpDir: this.#paths.tmpDir,
        })
      }
    }

    await pruneExpiredPartitions(handle.connection, {
      retentionDays: this.#retentionDays,
      parquetRoot: this.#paths.parquetRoot,
      nowMs,
    })
  }

  /** Flush pending writes and release the database handle (tests/shutdown). */
  async close(): Promise<void> {
    this.stopDailyArchiveTimer()
    this.#clearFlushTimer()
    try {
      await this.#flushPending({ rethrow: false })
    } finally {
      if (this.#openPromise !== null) {
        try {
          await this.#openPromise
        } catch {
          // Never opened successfully — nothing to close.
        }
      }
      this.#handle?.close()
      this.#handle = null
      this.#openPromise = null
    }
  }

  #ensureOpen(): Promise<DuckDbHandle> {
    if (this.#handle !== null) return Promise.resolve(this.#handle)
    if (this.#openPromise !== null) return this.#openPromise
    this.#openPromise = this.#openHandle()
      .then((handle) => {
        this.#handle = handle
        return handle
      })
      .catch((error) => {
        this.#openPromise = null
        throw error
      })
    return this.#openPromise
  }

  /**
   * `queryHostSummary`'s query source: the hot `server_host_samples` table,
   * unioned with its sealed host-family Parquet partitions overlapping the
   * queried range. Thin wrapper over {@link #familySamplesSource} for the
   * `"host"` family.
   */
  #hostSamplesSource(fromMs: number, toMs: number): Promise<string> {
    return this.#familySamplesSource(parquetFamily('host'), fromMs, toMs)
  }

  /**
   * Query source for any family: its hot table, unioned with its sealed
   * Parquet partitions overlapping `[fromMs, toMs)` (a no-op union when no
   * partition overlaps — the plain hot table is returned as-is). Mirrors
   * `runDailyArchiveOnce`'s per-family sealing, generalized to every
   * `PARQUET_FAMILIES` entry rather than just `"host"`.
   */
  async #familySamplesSource(family: ParquetFamily, fromMs: number, toMs: number): Promise<string> {
    const files = await listPartitionFilesInRange(
      this.#paths.parquetRoot,
      family.subdir,
      fromMs,
      toMs
    )
    if (files.length === 0) return family.table
    const fileList = files.map((file) => `'${escapeSqlString(file)}'`).join(', ')
    return (
      `(SELECT * FROM ${family.table} ` +
      `UNION ALL BY NAME ` +
      `SELECT * FROM read_parquet([${fileList}], union_by_name = true))`
    )
  }

  /**
   * Multi-entity, multi-metric series for one `PerEntityHostedFamily` —
   * real per-descriptor aggregation over the family's per-entity table
   * (unioned with its sealed Parquet partitions), bucketed by time and
   * grouped by entity id. `managed.ingress` / `managed.database_proxy` group
   * by `source_id` so distinct sources of the same `source_kind` stay
   * distinct entities — see `EntitySeriesQuery.entityIds`'s doc comment.
   */
  async queryEntitySeries(input: EntitySeriesQuery): Promise<EntitySeriesResult> {
    if (input.entityIds.length === 0) {
      return {
        kind: 'duckdb',
        available: true,
        serverId: input.serverId,
        family: input.family,
        metrics: input.metrics,
        resolutionSeconds: null,
        entities: [],
      }
    }
    await this.flushWrites()
    const serverId = assertSafeServerId(input.serverId)
    const config = entityFamilyConfig(input.family)
    const fields = assertNonEmptyFields(input.metrics)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)
    const bucketSeconds = assertPositiveInt(
      'resolutionSeconds',
      input.resolutionSeconds ?? DUCKDB_DEFAULT_BUCKET_SECONDS
    )

    const handle = await this.#ensureOpen()
    const source = await this.#familySamplesSource(
      parquetFamily(config.parquetKey),
      from.getTime(),
      to.getTime()
    )
    const metricSelects = fields.map((field) => {
      const descriptor = resolveEntityFieldDescriptor(input.family, config.entityScope, field)
      const column = entityMetricColumnForFamily(input.family, field)
      return `${hostFieldAggregateSql(descriptor, column)} AS "${field}"`
    })
    const inList = input.entityIds.map(() => '?').join(', ')
    const sql = [
      'SELECT',
      `  CAST((epoch_ms(sampled_at) // ${
        bucketSeconds * 1000
      }) * ${bucketSeconds} AS DOUBLE) AS bucket,`,
      `  ${config.idColumn} AS entity_id,`,
      `  CAST(count(*) AS DOUBLE) AS sample_count,`,
      `  ${metricSelects.join(',\n  ')}`,
      `FROM ${source}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND ${config.idColumn} IN (${inList})`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
      `GROUP BY bucket, ${config.idColumn}`,
      `ORDER BY bucket ASC`,
    ].join('\n')

    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      ...input.entityIds,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ])

    const rowsByEntity = new Map<string, DuckDbRow[]>()
    for (const row of reader.getRowObjectsJS()) {
      const entityId = typeof row.entity_id === 'string' ? row.entity_id : ''
      if (!entityId) continue
      const list = rowsByEntity.get(entityId)
      if (list) {
        list.push(row)
      } else {
        rowsByEntity.set(entityId, [row])
      }
    }

    const fromMs = from.getTime()
    const toMs = to.getTime()
    const entities: EntitySeriesEntityResult[] = input.entityIds.map((entityId) => {
      const rows = rowsByEntity.get(entityId) ?? []
      const points: EntitySeriesPoint[] = []
      let sampleCount = 0
      for (const row of rows) {
        const bucketEpochSeconds = toFiniteNumber(row.bucket)
        if (bucketEpochSeconds === null) continue
        const rowSamples = toFiniteNumber(row.sample_count) ?? 0
        sampleCount += rowSamples
        points.push({
          at: new Date(bucketEpochSeconds * 1000).toISOString(),
          values: parseMetricValues(fields, row),
          sampleCount: rowSamples,
        })
      }
      points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      const gapCount = computeSeriesGapCount({
        fromMs,
        toMs,
        resolutionSeconds: bucketSeconds,
        points,
      })
      return { entityId, points, sampleCount, gapCount }
    })

    return {
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      family: input.family,
      metrics: fields,
      resolutionSeconds: bucketSeconds,
      entities,
    }
  }

  /**
   * Distinct entity ids of `family` observed in `[from, to)` — unions the
   * hot table with sealed Parquet partitions the same way `queryEntitySeries`
   * does. `managed.ingress` / `managed.database_proxy` return `source_id`
   * values, not `source_kind` — same rule as `queryEntitySeries`.
   */
  async queryEntityIdsSeen(input: EntityIdsSeenQuery): Promise<EntityIdsSeenResult> {
    await this.flushWrites()
    const serverId = assertSafeServerId(input.serverId)
    const config = entityFamilyConfig(input.family)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)

    const handle = await this.#ensureOpen()
    const source = await this.#familySamplesSource(
      parquetFamily(config.parquetKey),
      from.getTime(),
      to.getTime()
    )
    const sql = [
      `SELECT DISTINCT ${config.idColumn} AS entity_id`,
      `FROM ${source}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND sampled_at >= CAST(? AS TIMESTAMP)`,
      `  AND sampled_at < CAST(? AS TIMESTAMP)`,
    ].join('\n')
    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ])
    const entityIds = reader
      .getRowObjectsJS()
      .map((row) => (typeof row.entity_id === 'string' ? row.entity_id : null))
      .filter((id): id is string => id !== null && id.length > 0)
      .sort((a, b) => a.localeCompare(b))

    return { kind: 'duckdb', available: true, entityIds }
  }

  /**
   * Discrete `server_metric_events` rows in `[from, to)`, unioned with sealed
   * `"events"` Parquet partitions, capped at {@link MAX_STATUS_EVENTS} (same
   * cap/truncation discipline as `queryStatusHistory`). Columns are selected
   * explicitly (not `SELECT *`) so `"at"` can be cast to an epoch-ms double —
   * the raw DuckDB `TIMESTAMP` value `getRowObjectsJS()` returns for an
   * unconverted column isn't a plain JS string/number, the same reason every
   * other read path in this file casts timestamps before reading them.
   */
  async queryMetricEvents(input: MetricEventsQuery): Promise<MetricEventsResult> {
    await this.flushWrites()
    const serverId = assertSafeServerId(input.serverId)
    const from = assertIsoTimestamp('from', input.from)
    const to = assertIsoTimestamp('to', input.to)
    assertRange(from, to)

    const handle = await this.#ensureOpen()
    const source = await this.#familySamplesSource(
      parquetFamily('events'),
      from.getTime(),
      to.getTime()
    )
    const sql = [
      'SELECT',
      `  event_id,`,
      `  CAST(epoch_ms("at") AS DOUBLE) AS at_ms,`,
      `  kind,`,
      `  severity,`,
      `  entity_id,`,
      `  source,`,
      `  payload`,
      `FROM ${source}`,
      `WHERE server_id = CAST(? AS UUID)`,
      `  AND "at" >= CAST(? AS TIMESTAMP)`,
      `  AND "at" < CAST(? AS TIMESTAMP)`,
      `ORDER BY "at" ASC`,
      `LIMIT ${MAX_STATUS_EVENTS + 1}`,
    ].join('\n')
    const reader = await handle.connection.runAndReadAll(sql, [
      serverId,
      toDuckDbTimestamp(from.toISOString()),
      toDuckDbTimestamp(to.toISOString()),
    ])
    const rawRows = reader.getRowObjectsJS()
    const truncated = rawRows.length > MAX_STATUS_EVENTS
    const rows = truncated ? rawRows.slice(0, MAX_STATUS_EVENTS) : rawRows
    const events = rows.map(parseMetricEventRow)

    return {
      kind: 'duckdb',
      available: true,
      serverId: input.serverId,
      events,
      truncated,
    }
  }

  /**
   * Enqueue every row produced by one `writeSample`/`writeStatusEvent` call
   * together, then check the flush threshold exactly once — so a sample
   * fanning out to many rows (e.g. 16 GPUs) never has its rows split across
   * two flush batches (and therefore two transactions).
   */
  async #enqueueRows(rows: PendingRow[]): Promise<void> {
    // Enqueue before any await so concurrent chart queries that
    // `flushWrites()` cannot race ahead of an in-flight open and observe an
    // empty pending buffer for a sample already accepted with 202.
    this.#pendingRows.push(...rows)
    if (this.#pendingRows.length >= this.#batchMaxRows) {
      await this.#flushPending({ rethrow: true })
      return
    }
    this.#armFlushTimer()
  }

  #armFlushTimer(): void {
    if (this.#flushTimer !== null) return
    this.#flushTimer = this.#setTimeout(() => {
      this.#flushTimer = null
      void this.#flushPending({ rethrow: false })
    }, this.#batchMaxAgeMs)
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer === null) return
    this.#clearTimeout(this.#flushTimer)
    this.#flushTimer = null
  }

  async #flushPending(opts: { rethrow: boolean }): Promise<void> {
    if (this.#flushPromise) {
      await this.#flushPromise
      if (this.#pendingRows.length === 0) return
    }
    this.#clearFlushTimer()
    if (this.#pendingRows.length === 0) return

    // Publish the in-flight promise *before* `#ensureOpen` so a concurrent
    // query `flushWrites()` waits for this insert instead of observing an
    // empty pending buffer and reading the DB mid-open.
    const run = this.#flushPendingBody(opts)
    this.#flushPromise = run.finally(() => {
      this.#flushPromise = null
    })
    await this.#flushPromise
  }

  async #flushPendingBody(opts: { rethrow: boolean }): Promise<void> {
    const handle = await this.#ensureOpen()
    if (this.#pendingRows.length === 0) return
    const batch = this.#pendingRows.splice(0)
    await this.#insertBatch(handle.connection, batch, opts.rethrow)
  }

  /** One transaction per flushed batch — every row a single `writeSample` produced lands (or rolls back) together. */
  async #insertBatch(
    connection: DuckDbConnectionLike,
    batch: PendingRow[],
    rethrow: boolean
  ): Promise<void> {
    const byTable = new Map<PendingRowTable, DuckDbBindValue[][]>()
    for (const row of batch) {
      const rows = byTable.get(row.table)
      if (rows) {
        rows.push(row.values)
      } else {
        byTable.set(row.table, [row.values])
      }
    }
    try {
      await connection.run('BEGIN TRANSACTION')
      try {
        for (const [table, rows] of byTable) {
          const { sql, values } = buildInsertForTable(table, rows)
          await connection.run(sql, values)
        }
        await connection.run('COMMIT')
      } catch (error) {
        await connection.run('ROLLBACK').catch(() => {})
        throw error
      }
    } catch (error) {
      // Re-queue so a later query flush / timer can retry; dropping the batch
      // permanently would leave charts empty after a transient hiccup.
      this.#pendingRows.unshift(...batch)
      this.#onFlushError(error)
      if (rethrow) throw error
      this.#armFlushTimer()
    }
  }
}

function defaultFlushErrorLog(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`duckdb metrics write flush failed: ${message}`)
}

/** Raw field value off an entity/group object — real value or SQL `NULL`, never a sentinel or coerced `0`. */
function numericField(source: unknown, field: string): number | null {
  return (source as Record<string, number | null>)[field] ?? null
}

// ---------------------------------------------------------------------------
// Per-table parameterized INSERT builders — column lists come from
// `schema.ts` (the single source of truth also used for DDL); tuples here
// only add the `CAST(... AS ...)` coercions bound string/number parameters
// need for UUID/TIMESTAMP/SMALLINT/BIGINT/INTEGER columns.
// ---------------------------------------------------------------------------

const COMMON_METADATA_TUPLE_PREFIX = [
  'CAST(? AS UUID)',
  'CAST(? AS TIMESTAMP)',
  'CAST(? AS TIMESTAMP)',
  'CAST(? AS SMALLINT)',
  'CAST(? AS BIGINT)',
  'CAST(? AS INTEGER)',
  'CAST(? AS INTEGER)',
]

function entityTuple(idPlaceholders: readonly string[], metricCount: number): string {
  return (
    '(' +
    [
      ...COMMON_METADATA_TUPLE_PREFIX,
      ...idPlaceholders,
      ...new Array<string>(metricCount).fill('?'),
    ].join(', ') +
    ')'
  )
}

const HOST_COLUMNS = hostSamplesInsertColumns()
const HOST_TUPLE = entityTuple(
  [],
  HOST_METRIC_FIELD_REFS.length + HOST_GLOBAL_CPU_DIAGNOSTICS_FIELDS_LIST.length
)

const NETWORK_COLUMNS = networkSamplesInsertColumns()
const NETWORK_TUPLE = entityTuple(['?'], NETWORK_METRIC_FIELDS.length)

const FILESYSTEM_COLUMNS = filesystemSamplesInsertColumns()
const FILESYSTEM_TUPLE = entityTuple(['?'], FILESYSTEM_METRIC_FIELDS.length)

const BLOCK_COLUMNS = blockSamplesInsertColumns()
const BLOCK_TUPLE = entityTuple(['?'], BLOCK_METRIC_FIELDS.length)

const GPU_COLUMNS = gpuSamplesInsertColumns()
const GPU_TUPLE = entityTuple(['?'], GPU_METRIC_FIELDS.length)

const MEMORY_DIAGNOSTICS_COLUMNS = memoryDiagnosticsSamplesInsertColumns()
const MEMORY_DIAGNOSTICS_TUPLE = entityTuple([], MEMORY_DIAGNOSTICS_METRIC_FIELDS.length)

const HARDWARE_SIGNAL_COLUMNS = hardwareSignalSamplesInsertColumns()
const HARDWARE_SIGNAL_TUPLE = entityTuple(['?', '?'], 1)

const INGRESS_COLUMNS = ingressSamplesInsertColumns()
const INGRESS_TUPLE = entityTuple(['?', '?'], INGRESS_METRIC_FIELDS.length)

const DATABASE_PROXY_COLUMNS = databaseProxySamplesInsertColumns()
const DATABASE_PROXY_TUPLE = entityTuple(['?', '?'], DATABASE_PROXY_METRIC_FIELDS.length)

const ROUTER_COLUMNS = routerSamplesInsertColumns()
const ROUTER_TUPLE = entityTuple([], ROUTER_METRIC_FIELDS.length)

const STORAGE_COLUMNS = storageSamplesInsertColumns()
// Four trailing VARCHAR id columns after the metric doubles — bound as plain
// `?` placeholders like every other non-numeric column.
const STORAGE_TUPLE = entityTuple(
  [],
  storageSamplesMetricColumnNames().length + STORAGE_FILESYSTEM_ID_COLUMNS.length
)

const DOCKER_COLUMNS = dockerSamplesInsertColumns()
const DOCKER_TUPLE = entityTuple([], DOCKER_USAGE_METRIC_FIELDS.length)

const EVENT_COLUMNS = metricEventsInsertColumns()
const EVENT_TUPLE =
  '(CAST(? AS UUID), ?, CAST(? AS TIMESTAMP), CAST(? AS TIMESTAMP), ?, ?, CAST(? AS INTEGER), ?, ?, ?)'

const STATUS_COLUMNS = ['server_id', `"at"`, 'connected', 'reason']
const STATUS_TUPLE = '(CAST(? AS UUID), CAST(? AS TIMESTAMP), ?, ?)'

function buildInsertSql(
  table: string,
  columns: readonly string[],
  tuple: string,
  rowCount: number
): string {
  const tuples = new Array<string>(rowCount).fill(tuple).join(', ')
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples}`
}

function buildInsertForTable(
  table: PendingRowTable,
  rows: DuckDbBindValue[][]
): { sql: string; values: DuckDbBindValue[] } {
  const values = rows.flat()
  switch (table) {
    case 'host':
      return {
        sql: buildInsertSql(HOST_SAMPLES_TABLE, HOST_COLUMNS, HOST_TUPLE, rows.length),
        values,
      }
    case 'network':
      return {
        sql: buildInsertSql(NETWORK_SAMPLES_TABLE, NETWORK_COLUMNS, NETWORK_TUPLE, rows.length),
        values,
      }
    case 'filesystem':
      return {
        sql: buildInsertSql(
          FILESYSTEM_SAMPLES_TABLE,
          FILESYSTEM_COLUMNS,
          FILESYSTEM_TUPLE,
          rows.length
        ),
        values,
      }
    case 'block':
      return {
        sql: buildInsertSql(BLOCK_SAMPLES_TABLE, BLOCK_COLUMNS, BLOCK_TUPLE, rows.length),
        values,
      }
    case 'gpu':
      return {
        sql: buildInsertSql(GPU_SAMPLES_TABLE, GPU_COLUMNS, GPU_TUPLE, rows.length),
        values,
      }
    case 'memoryDiagnostics':
      return {
        sql: buildInsertSql(
          MEMORY_DIAGNOSTICS_SAMPLES_TABLE,
          MEMORY_DIAGNOSTICS_COLUMNS,
          MEMORY_DIAGNOSTICS_TUPLE,
          rows.length
        ),
        values,
      }
    case 'hardwareSignal':
      return {
        sql: buildInsertSql(
          HARDWARE_SIGNAL_SAMPLES_TABLE,
          HARDWARE_SIGNAL_COLUMNS,
          HARDWARE_SIGNAL_TUPLE,
          rows.length
        ),
        values,
      }
    case 'ingress':
      return {
        sql: buildInsertSql(INGRESS_SAMPLES_TABLE, INGRESS_COLUMNS, INGRESS_TUPLE, rows.length),
        values,
      }
    case 'databaseProxy':
      return {
        sql: buildInsertSql(
          DATABASE_PROXY_SAMPLES_TABLE,
          DATABASE_PROXY_COLUMNS,
          DATABASE_PROXY_TUPLE,
          rows.length
        ),
        values,
      }
    case 'router':
      return {
        sql: buildInsertSql(ROUTER_SAMPLES_TABLE, ROUTER_COLUMNS, ROUTER_TUPLE, rows.length),
        values,
      }
    case 'storage':
      return {
        sql: buildInsertSql(STORAGE_SAMPLES_TABLE, STORAGE_COLUMNS, STORAGE_TUPLE, rows.length),
        values,
      }
    case 'docker':
      return {
        sql: buildInsertSql(DOCKER_SAMPLES_TABLE, DOCKER_COLUMNS, DOCKER_TUPLE, rows.length),
        values,
      }
    case 'event':
      return {
        sql: buildInsertSql(METRIC_EVENTS_TABLE, EVENT_COLUMNS, EVENT_TUPLE, rows.length),
        values,
      }
    case 'status':
      return {
        sql: buildInsertSql(STATUS_EVENTS_TABLE, STATUS_COLUMNS, STATUS_TUPLE, rows.length),
        values,
      }
    default: {
      const exhaustive: never = table
      throw new TypeError(`unknown pending row table: ${exhaustive}`)
    }
  }
}

/** DuckDB `TIMESTAMP`-castable UTC string from an ISO timestamp. */
function toDuckDbTimestamp(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid timestamp: ${iso}`)
  }
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

function toFiniteNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const num = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(num) ? num : null
}

// ---------------------------------------------------------------------------
// v3-compat query helpers (`queryHostSeries`/`queryHostSummary`/
// `queryFleetHostSnapshot`) — bucket aggregation and row parsing over the v5
// `server_host_samples` shape, restricted to `V3_TO_V5_HOST_COLUMN`'s keys.
// ---------------------------------------------------------------------------

/**
 * Interval-weighted average over real named columns with real NULLs:
 * `SUM(value * interval_seconds) / SUM(interval_seconds)` restricted to rows
 * where the metric is present — a NULL metric contributes neither value nor
 * weight, so missing never averages as zero. `weightColumn` lets a joined
 * query (`queryHostSeries`'s `md` join) qualify the otherwise-ambiguous
 * `interval_seconds` name.
 */
function intervalWeightedAvgSql(column: string, weightColumn = 'interval_seconds'): string {
  return (
    `SUM(${column} * ${weightColumn})` +
    ` / (SUM(${weightColumn}) FILTER (WHERE ${column} IS NOT NULL))`
  )
}

/**
 * Latest present value in the group — `arg_max` over `sampled_at` restricted
 * to rows where the metric is present, so a trailing NULL sample never
 * blanks a slow-moving gauge. `orderColumn` lets a joined query
 * (`queryHostSeries`'s `md` join) qualify the otherwise-ambiguous
 * `sampled_at` name.
 */
function lastValueSql(column: string, orderColumn = 'sampled_at'): string {
  return `arg_max(${column}, ${orderColumn}) FILTER (WHERE ${column} IS NOT NULL)`
}

/** Group maximum — NULLs are ignored by SQL `MAX` semantics. */
function maxValueSql(column: string): string {
  return `MAX(${column})`
}

/**
 * Bucket total for a monotonic counter — each stored value is already a
 * per-interval delta, so summing it is the bucket total. NULLs are ignored
 * by SQL `SUM` semantics, so an all-missing group correctly sums to NULL
 * rather than a fabricated 0.
 */
function sumValueSql(column: string): string {
  return `SUM(${column})`
}

/**
 * Parse a `string_agg(DISTINCT CAST(topology_generation AS VARCHAR), ',')`
 * aggregate into the distinct generations observed, sorted ascending.
 * `string_agg` drops NULLs, so an all-NULL group yields an empty array.
 */
function parseHardwareProfileGenerations(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const values = new Set<number>()
  for (const token of raw.split(',')) {
    const value = toFiniteNumber(token.trim())
    if (value !== null) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Query helpers (`queryHostSeries`/`queryFleetHostSnapshot`,
// `queryEntitySeries`/`queryEntityIdsSeen`/`queryMetricEvents`) — real
// per-descriptor aggregation over `HOST_METRICS_METRIC_DESCRIPTORS`.
// ---------------------------------------------------------------------------

/**
 * Descriptor-driven bucket aggregate for one v5 canonical metric —
 * weighted-average/last/max/delta-sum per
 * `HostMetricsMetricDescriptor.aggregation`, over any real column (host or
 * per-entity). Every v5 canonical name that resolves to a descriptor has a
 * real column — there is no `NULL`-literal fallback case here.
 */
function hostFieldAggregateSql(
  descriptor: HostMetricsMetricDescriptor,
  column: string,
  /**
   * Table-alias prefix (e.g. `"h."`) for the `sampled_at`/`interval_seconds`
   * metadata columns `last`/`weighted-average` order/weight by — required
   * whenever the query joins another table exposing its own same-named
   * metadata columns (`queryHostSeries`'s `md` join), else those bare
   * names are ambiguous. Empty string (the default) for every other,
   * unjoined call site.
   */
  metaPrefix = ''
): string {
  switch (descriptor.aggregation) {
    case 'last':
      return lastValueSql(column, `${metaPrefix}sampled_at`)
    case 'max':
      return maxValueSql(column)
    case 'delta-sum':
      return sumValueSql(column)
    case 'weighted-average':
    default:
      return intervalWeightedAvgSql(column, `${metaPrefix}interval_seconds`)
  }
}

/** DuckDB column for a `host.*`-scoped descriptor — `entityScope` minus its `"host."` prefix is the {@link HostMetricGroup}. */
function hostColumnForDescriptor(descriptor: HostMetricsMetricDescriptor): string {
  const group = descriptor.entityScope.slice('host.'.length) as HostMetricGroup
  return hostMetricColumnName(group, descriptor.fieldName)
}

/**
 * Which half of the merged `diagnostics` family a field belongs to. v6 has a
 * single `diagnostics` entity scope but two physical homes, so the split is
 * by field name — the two halves share no field name, and both lists are
 * derived from the schema module rather than restated here.
 */
const CPU_DIAGNOSTICS_FIELD_SET: ReadonlySet<string> = new Set(DIAGNOSTICS_CPU_FIELD_NAMES)
const MEMORY_DIAGNOSTICS_FIELD_SET: ReadonlySet<string> = new Set(MEMORY_DIAGNOSTICS_METRIC_FIELDS)

function diagnosticsFieldName(metric: string): string | undefined {
  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[metric]
  return descriptor?.entityScope === 'diagnostics' ? descriptor.fieldName : undefined
}

/** `true` when `metric` is a diagnostics field stored on the host row's `cpu_diagnostics_*` columns. */
function isCpuDiagnosticsMetric(metric: string): boolean {
  const field = diagnosticsFieldName(metric)
  return field !== undefined && CPU_DIAGNOSTICS_FIELD_SET.has(field)
}

/** `true` when `metric` is a diagnostics field stored in the singleton memory-diagnostics table. */
function isMemoryDiagnosticsMetric(metric: string): boolean {
  const field = diagnosticsFieldName(metric)
  return field !== undefined && MEMORY_DIAGNOSTICS_FIELD_SET.has(field)
}

/** `true` when `metric` is a `managed.router` field, stored in the singleton router table. */
function isRouterMetric(metric: string): boolean {
  return HOST_METRICS_METRIC_DESCRIPTORS[metric]?.entityScope === 'router'
}

/** `true` when `metric` is a `managed.storage` field, stored in the singleton storage table. */
function isStorageMetric(metric: string): boolean {
  return HOST_METRICS_METRIC_DESCRIPTORS[metric]?.entityScope === 'storage'
}

/** `true` when `metric` is a `managed.docker` field, stored in the singleton docker table. */
function isDockerUsageMetric(metric: string): boolean {
  return HOST_METRICS_METRIC_DESCRIPTORS[metric]?.entityScope === 'dockerUsage'
}

/**
 * DuckDB column reference for a `queryHostSeries` descriptor, scoped to
 * the `h`/`md`/`rt` aliases that query's SQL declares. `host.*` fields and
 * the diagnostics CPU half both live on the host row (`h` — the latter via
 * `cpuDiagnosticsHostColumnName`'s `cpu_diagnostics_*` columns); the
 * diagnostics memory half lives on one left-joined singleton row (`md`) and
 * the `managed.router` family on another (`rt`).
 */
function hostSeriesColumnForDescriptor(descriptor: HostMetricsMetricDescriptor): string {
  if (descriptor.entityScope === 'router') {
    return `rt.${entityMetricColumnName(descriptor.fieldName)}`
  }
  // `managed.storage`'s flattened field names (`postgresInstancesRunning`)
  // snake_case straight to their storage-table columns; `managed.docker`
  // resolves against its own table, whose columns are unprefixed (the
  // `docker_*`-prefixed copies on the storage row are a convenience for
  // single-row storage panels, not the queryable series).
  if (descriptor.entityScope === 'storage') {
    return `st.${entityMetricColumnName(descriptor.fieldName)}`
  }
  if (descriptor.entityScope === 'dockerUsage') {
    return `dk.${entityMetricColumnName(descriptor.fieldName)}`
  }
  if (descriptor.entityScope === 'diagnostics') {
    return CPU_DIAGNOSTICS_FIELD_SET.has(descriptor.fieldName)
      ? `h.${cpuDiagnosticsHostColumnName(descriptor.fieldName)}`
      : `md.${entityMetricColumnName(descriptor.fieldName)}`
  }
  return `h.${hostColumnForDescriptor(descriptor)}`
}

/** Extra host-singleton scopes `queryHostSeries` accepts beyond `host.*` — see its doc comment. */
const HOST_SERIES_EXTRA_SCOPES: ReadonlySet<MetricEntityScope> = new Set([
  'diagnostics',
  'router',
  'storage',
  'dockerUsage',
])

const NO_EXTRA_SCOPES: ReadonlySet<MetricEntityScope> = new Set()

/**
 * Validate `metrics` as a non-empty list of v5 canonical names, each
 * resolving to a `HOST_METRICS_METRIC_DESCRIPTORS` entry scoped to
 * `host.*` (the only scope `queryFleetHostSnapshot`'s v5 path reads) or, when
 * `extraScopes` is passed (`queryHostSeries` only), one of those extra
 * scopes.
 */
function assertHostMetrics(
  metrics: readonly string[],
  extraScopes: ReadonlySet<MetricEntityScope> = NO_EXTRA_SCOPES
): string[] {
  if (metrics.length === 0) {
    throw new TypeError('metrics must be a non-empty list of v5 canonical names')
  }
  const out: string[] = []
  for (const name of metrics) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[name]
    const scopeOk =
      descriptor !== undefined &&
      (descriptor.entityScope.startsWith('host.') || extraScopes.has(descriptor.entityScope))
    if (!scopeOk) {
      throw new TypeError(`unknown host metrics v5 canonical name: ${name}`)
    }
    out.push(name)
  }
  return out
}

function parseHostSeriesRows(
  metrics: readonly string[],
  rows: DuckDbRow[],
  resolutionSeconds: number
): {
  points: HostSeriesPoint[]
  sampleCount: number
  topologyGenerations: number[]
} {
  const points: HostSeriesPoint[] = []
  let sampleCount = 0
  const allGenerations = new Set<number>()
  for (const row of rows) {
    const bucketEpochSeconds = toFiniteNumber(row.bucket)
    if (bucketEpochSeconds === null) continue
    const rowSamples = toFiniteNumber(row.sample_count) ?? 0
    sampleCount += rowSamples
    const avgIntervalSeconds = toFiniteNumber(row.avg_interval_seconds)
    const expectedSampleCount =
      avgIntervalSeconds !== null
        ? defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)
        : defaultExpectedSamplesPerBucket(resolutionSeconds)
    const bucketGenerations = parseHardwareProfileGenerations(row.topology_gen_raw)
    for (const generation of bucketGenerations) allGenerations.add(generation)
    const point: HostSeriesPoint = {
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values: parseMetricValues(metrics, row),
      sampleCount: rowSamples,
      expectedSampleCount,
      topologyGeneration: bucketGenerations.length === 1 ? bucketGenerations[0]! : null,
    }
    points.push(point)
  }
  return {
    points,
    sampleCount,
    topologyGenerations: [...allGenerations].sort((a, b) => a - b),
  }
}

function parseMetricValues(
  metrics: readonly string[],
  row: DuckDbRow
): Partial<Record<string, number | null>> {
  const values: Partial<Record<string, number | null>> = {}
  for (const key of metrics) {
    values[key] = toFiniteNumber(row[key])
  }
  return values
}

/** Per-family static config for `queryEntitySeries`/`queryEntityIdsSeen`. */
type EntityFamilyConfig = {
  parquetKey: ParquetFamilyKey
  /** Physical id column queried/grouped on — `source_id` (not `source_kind`) for the two managed families. */
  idColumn: string
  entityScope: MetricEntityScope
}

/**
 * Static per-family table/column/entity-scope mapping for
 * `queryEntitySeries`/`queryEntityIdsSeen` — mirrors
 * `EntitySeriesQuery.entityIds`'s doc comment on what "entity id" means
 * per family (`source_id`, not `source_kind`, for the two managed families).
 */
function entityFamilyConfig(family: PerEntityHostedFamily): EntityFamilyConfig {
  switch (family) {
    case 'gpu':
      return { parquetKey: 'gpu', idColumn: 'gpu_id', entityScope: 'gpu' }
    case 'network':
      return {
        parquetKey: 'network',
        idColumn: 'device_id',
        entityScope: 'network',
      }
    case 'filesystem':
      return {
        parquetKey: 'filesystem',
        idColumn: 'filesystem_id',
        entityScope: 'filesystem',
      }
    case 'block':
      return {
        parquetKey: 'block',
        idColumn: 'device_id',
        entityScope: 'block',
      }
    case 'hardware.physical':
      return {
        parquetKey: 'hardware',
        idColumn: 'signal_id',
        entityScope: 'hardwareSignal',
      }
    case 'managed.ingress':
      return {
        parquetKey: 'ingress',
        idColumn: 'source_id',
        entityScope: 'ingress',
      }
    case 'managed.database_proxy':
      return {
        parquetKey: 'database-proxy',
        idColumn: 'source_id',
        entityScope: 'databaseProxy',
      }
    default: {
      const exhaustive: never = family
      throw new TypeError(`unknown per-entity hosted family: ${exhaustive}`)
    }
  }
}

/** Resolve one requested bare field name to its descriptor, scoped to `family`'s entity scope. */
function resolveEntityFieldDescriptor(
  family: PerEntityHostedFamily,
  entityScope: MetricEntityScope,
  field: string
): HostMetricsMetricDescriptor {
  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS[`${entityScope}.${field}`]
  if (!descriptor) {
    throw new TypeError(`unknown ${family} metrics field: ${field}`)
  }
  return descriptor
}

/** `hardware.physical` is long-form (one `value` column, not one column per field); every other family uses `entityMetricColumnName`. */
function entityMetricColumnForFamily(family: PerEntityHostedFamily, field: string): string {
  return family === 'hardware.physical' ? 'value' : entityMetricColumnName(field)
}

function assertNonEmptyFields(metrics: readonly string[]): string[] {
  if (metrics.length === 0) {
    throw new TypeError('metrics must be a non-empty list of field names')
  }
  return [...metrics]
}

/**
 * Parse one `server_metric_events` row (see `queryMetricEvents`'s SQL) into
 * a `MetricEvent` — omits `entityId`/`source`/`payload` entirely when
 * absent (never writes an `undefined` value into the object), and treats a
 * corrupt `payload` JSON string as "no payload" rather than throwing.
 */
function parseMetricEventRow(row: DuckDbRow): MetricEvent {
  const atMs = toFiniteNumber(row.at_ms) ?? 0
  const event: MetricEvent = {
    eventId: String(row.event_id ?? ''),
    at: new Date(atMs).toISOString(),
    kind: String(row.kind ?? '') as MetricEventKind,
    severity: String(row.severity ?? '') as MetricEventSeverity,
  }
  if (typeof row.entity_id === 'string' && row.entity_id.length > 0) {
    event.entityId = row.entity_id
  }
  if (typeof row.source === 'string' && row.source.length > 0) {
    event.source = row.source
  }
  if (typeof row.payload === 'string' && row.payload.length > 0) {
    try {
      const parsed = JSON.parse(row.payload)
      if (parsed !== null && typeof parsed === 'object') {
        event.payload = parsed as Record<string, string | number | boolean | null>
      }
    } catch {
      // Corrupt payload — treated as absent rather than thrown.
    }
  }
  return event
}

function dedupeServerIds(serverIds: readonly string[]): string[] {
  if (serverIds.length > DUCKDB_MAX_FLEET_SNAPSHOT_SERVERS) {
    throw new TypeError(
      `serverIds length ${serverIds.length} exceeds max ${DUCKDB_MAX_FLEET_SNAPSHOT_SERVERS}`
    )
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of serverIds) {
    const id = assertSafeServerId(raw)
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  if (out.length === 0) {
    throw new TypeError('serverIds must be non-empty for fleet snapshot')
  }
  return out
}

function parseStatusConnected(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'boolean') return raw
  const num = toFiniteNumber(raw)
  if (num === null) return null
  return num >= 0.5
}

function assertSafeServerId(serverId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serverId)) {
    throw new TypeError(`invalid serverId for DuckDB: ${serverId}`)
  }
  return serverId
}

function assertIsoTimestamp(label: string, value: string): Date {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid ${label} timestamp: ${value}`)
  }
  return new Date(ms)
}

function assertRange(from: Date, to: Date): void {
  const spanSeconds = (to.getTime() - from.getTime()) / 1000
  if (spanSeconds < 0) {
    throw new TypeError('from must be <= to')
  }
  if (spanSeconds > AE_DEFAULT_MAX_RANGE_SECONDS) {
    throw new TypeError(
      `query range ${spanSeconds}s exceeds maxRangeSeconds ${AE_DEFAULT_MAX_RANGE_SECONDS}`
    )
  }
}

function assertPositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return value
}

function assertOptionalPositiveInt(label: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return assertPositiveInt(label, value)
}
