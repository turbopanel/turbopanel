/**
 * Query-side SQL primitives for the v5 Analytics Engine dataset
 * (`turbopanel_server_metrics_v5` — see `field-map-v5.ts`).
 *
 * Host-level aggregates (`host.system` / `host.io`) are simple: every sample
 * writes exactly one `host.system` row and one `host.io` row — unlike v3's
 * `core`/`extended`/`sensors`/`traffic` split, there is no physical-row
 * recombination needed to read a host metric.
 *
 * Per-entity series (`queryEntitySeriesViaSqlApiV5`) for the paged
 * `gpu`/`network`/`filesystem`/`block`/`hardware.physical` families are
 * harder, because a page's blob10 identity list (which entities occupy which
 * double-slot "position") can differ across time within the same queried
 * range — a topology change reshuffles page composition. There is no
 * documented AE array/split function to extract "the value at position k of
 * this comma list" in SQL, so this module never tries: instead, the SQL
 * query selects, for **every** candidate slot position `0..entitiesPerPage-1`,
 * that position's raw (not-yet-divided) aggregate pieces, grouped by
 * `(bucket, blob10)` — one row per distinct page composition seen in a
 * bucket. The result rows are then walked in TypeScript
 * (`parsePagedEntitySeriesRowsV5`): each row's `blob10` is split to learn
 * which requested entity sits at which position in *that* row, and the raw
 * pieces for that position are accumulated per `(bucket, entityId, field)`
 * across every contributing row before the final ratio/max/last is resolved
 * — so an entity that moves between page compositions over time (or shares a
 * bucket with more than one page composition) still recombines correctly.
 * `managed.ingress` / `managed.database_proxy` need none of this: they write
 * one unpaged row per entity with blob10 already equal to the entity's own
 * identity (`sourceId`, distinct per source instance even when two sources
 * share the same `sourceKind`), so `queryEntitySeriesViaSqlApiV5` groups
 * those two families directly by `(bucket, blob10)` with no position math at
 * all.
 */

import {
  HOST_METRICS_METRIC_DESCRIPTORS_V5,
  type HostedFamilyV5,
  type HostMetricsMetricDescriptorV5,
  type MetricEntityScopeV5,
} from '../../metric-descriptors-v5.ts'
import type {
  EntityIdsSeenQueryV5,
  EntityIdsSeenResultV5,
  EntitySeriesEntityResultV5,
  EntitySeriesPointV5,
  EntitySeriesQueryV5,
  EntitySeriesResultV5,
  FleetHostSnapshotQueryV5,
  FleetHostSnapshotResultV5,
  FleetHostSnapshotServerV5,
  HostSeriesQueryV5,
  HostSeriesResultV5,
  HostSummaryQueryV5,
  HostSummaryResultV5,
  MetricEventsQueryV5,
  MetricEventsResultV5,
  PerEntityHostedFamilyV5,
  ServerStatusTransitionReason,
  SlotMapping,
  StatusHistoryEvent,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../types-v5.ts'
import type { MetricEventKindV5, MetricEventSeverityV5, MetricEventV5 } from '../../contract-v5.ts'
import { computeStatusUptime } from '../../query/uptime.ts'
import {
  computeSeriesGapCount,
  defaultExpectedSamplesPerBucket,
  finalizeHostSeriesResultV5,
} from '../../query/series-response-v5.ts'
import {
  AE_V5_BLOB_EVENT_ENTITY_ID_INDEX,
  AE_V5_BLOB_EVENT_ID_INDEX,
  AE_V5_BLOB_EVENT_PAYLOAD_INDEX,
  AE_V5_BLOB_FAMILY_INDEX,
  AE_V5_BLOB_KIND_INDEX,
  AE_V5_BLOB_SCHEMA_VERSION_INDEX,
  AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX,
  AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX,
  AE_V5_DATASET_NAME,
  AE_V5_FAMILY_CPU_DETAIL,
  AE_V5_FAMILY_HOST_IO,
  AE_V5_FAMILY_HOST_SYSTEM,
  AE_V5_FAMILY_MEMORY_DETAIL,
  AE_V5_INDEX_SERVER_ID_COLUMN,
  AE_V5_KIND_EVENT,
  AE_V5_KIND_METRICS,
  AE_V5_KIND_STATUS,
  AE_V5_TIMESTAMP_COLUMN,
  blobColumnV5,
  doubleColumnV5,
  doubleIndexForHostField,
  entitiesPerPage,
  HOST_IO_EMBEDDED_NIC_FIELDS,
  hostIoEmbeddedNicDoubleIndex,
  intervalSecondsColumnV5,
  PER_ENTITY_FIELD_ORDER_V5,
  SINGLE_ROW_FIELD_ORDER_V5,
  slotDoubleIndex,
  statusConnectedColumnV5,
  statusReasonColumnV5,
} from './field-map-v5.ts'

export { AE_V5_DATASET_NAME }

/** Schema versions this read path understands (positional semantics must match). */
export const AE_V5_SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [5]

/** Escape a string literal for AE SQL (single-quote doubling). Same idiom as v3's `quoteSqlString`. */
export function quoteSqlStringV5(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function assertSafeDatasetNameV5(dataset: string): string {
  if (dataset !== AE_V5_DATASET_NAME && !/^[a-zA-Z_]\w*$/.test(dataset)) {
    throw new TypeError(`invalid AE v5 dataset name: ${dataset}`)
  }
  return dataset
}

function assertPositiveIntV5(label: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer, got: ${value}`)
  }
  return value
}

/** Accept only string serverIds from AE rows — never stringify objects. Local to this module (not exported by `sql-api.ts`). */
function parseAeServerIdV5(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  return id.length > 0 ? id : null
}

// ---------------------------------------------------------------------------
// Shared HTTP/SQL transport + generic status-row primitives.
//
// These are backend/version-agnostic (raw HTTP client over the Cloudflare
// Analytics Engine SQL API, generic `{ timestamp, connected, reason }` status
// rows shared with the DuckDB backend's own status query) — this module is
// their sole surviving home after the v3 cutover; nothing here is v5-shaped.
// ---------------------------------------------------------------------------

/**
 * Default safety-net max query window — matches documented AE retention
 * (three months / 90 days). Override via `CloudflareAnalyticsSqlConfig.maxRangeSeconds`
 * or `TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS` on Workers.
 */
export const AE_DEFAULT_MAX_RANGE_SECONDS = 90 * 24 * 60 * 60

/** Default bucket when `resolutionSeconds` is omitted (5 minutes). */
export const AE_DEFAULT_BUCKET_SECONDS = 300

export function assertSafeServerId(serverId: string): string {
  // Canonical UUID (any version) — reject anything that could break out of a string literal.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serverId)) {
    throw new TypeError(`invalid serverId for AE SQL: ${serverId}`)
  }
  return serverId
}

export function assertIsoTimestamp(label: string, value: string): Date {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new TypeError(`invalid ${label} timestamp: ${value}`)
  }
  return new Date(ms)
}

export function assertRange(from: Date, to: Date, maxRangeSeconds: number): void {
  const spanSeconds = (to.getTime() - from.getTime()) / 1000
  if (spanSeconds <= 0) {
    throw new TypeError('range must satisfy from < to')
  }
  if (spanSeconds > maxRangeSeconds) {
    throw new TypeError(`range exceeds max of ${maxRangeSeconds} seconds`)
  }
}

export type CloudflareAnalyticsSqlConfig = {
  accountId: string
  apiToken: string
  /** Dataset / table name (defaults to `AE_V5_DATASET_NAME`). */
  dataset?: string
  /**
   * Max allowed `to - from` span in seconds.
   * Defaults to `AE_DEFAULT_MAX_RANGE_SECONDS` (documented AE retention).
   */
  maxRangeSeconds?: number
  /** Injected for tests. */
  fetch?: typeof fetch
  /** Cancels the SQL subrequest rather than abandoning it. */
  signal?: AbortSignal
}

/** SQL payload nested under the Cloudflare v5 `result` field. */
export type AnalyticsEngineSqlResult = {
  meta?: Array<{ name: string; type: string }>
  data: Array<Record<string, unknown>>
  rows?: number
}

type CloudflareV5Error =
  | {
      code?: number
      message?: string
    }
  | string

type CloudflareV5SqlEnvelope = {
  success: boolean
  errors?: CloudflareV5Error[]
  messages?: unknown[]
  result?: {
    meta?: Array<{ name: string; type: string }>
    data?: Array<Record<string, unknown>>
    rows?: number
    error?: string
  } | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function formatCloudflareV5Error(err: CloudflareV5Error): string {
  if (typeof err === 'string') return err.trim()
  const msg = err.message?.trim()
  if (msg) return msg
  if (err.code != null) return `code=${err.code}`
  return ''
}

function collectAeSqlFailureDetail(
  envelope: CloudflareV5SqlEnvelope & Record<string, unknown>
): string {
  const messages = (envelope.errors ?? [])
    .map(formatCloudflareV5Error)
    .filter((msg) => msg.length > 0)
  const result = envelope.result
  if (isPlainObject(result) && typeof result.error === 'string' && result.error.trim()) {
    messages.push(result.error.trim())
  }
  if (messages.length > 0) return messages.join('; ')
  return `opaque body keys=${Object.keys(envelope)
    .sort((a, b) => a.localeCompare(b))
    .join(',')}`
}

function unwrapAeSqlSuccessResult(
  result: NonNullable<CloudflareV5SqlEnvelope['result']>
): AnalyticsEngineSqlResult {
  if (typeof result.error === 'string' && result.error.length > 0) {
    throw new Error(`AE SQL query error: ${result.error}`)
  }
  const data = result.data
  if (data === undefined || data === null) {
    return {
      meta: result.meta,
      data: [],
      rows: typeof result.rows === 'number' ? result.rows : undefined,
    }
  }
  if (!Array.isArray(data)) {
    throw new TypeError('AE SQL response result.data is not an array')
  }
  return {
    meta: result.meta,
    data,
    rows: typeof result.rows === 'number' ? result.rows : undefined,
  }
}

export function parseCloudflareV5SqlResponse(body: unknown): AnalyticsEngineSqlResult {
  if (!isPlainObject(body)) {
    throw new TypeError('AE SQL response is not a JSON object')
  }
  const envelope = body as CloudflareV5SqlEnvelope & {
    data?: Array<Record<string, unknown>>
    meta?: Array<{ name: string; type: string }>
    rows?: number
  }

  // ClickHouse FORMAT JSON / bare SQL result — no v5 `success` field.
  if (envelope.success === undefined && Array.isArray(envelope.data)) {
    return {
      meta: envelope.meta,
      data: envelope.data,
      rows: typeof envelope.rows === 'number' ? envelope.rows : undefined,
    }
  }

  if (envelope.success !== true) {
    throw new Error(`AE SQL API error: ${collectAeSqlFailureDetail(envelope)}`)
  }
  const result = envelope.result
  if (result == null) {
    return { data: [] }
  }
  if (!isPlainObject(result)) {
    throw new TypeError('AE SQL response result is not an object')
  }
  return unwrapAeSqlSuccessResult(result)
}

async function executeSql(
  config: CloudflareAnalyticsSqlConfig,
  sql: string
): Promise<AnalyticsEngineSqlResult> {
  const accountId = config.accountId.trim()
  if (!accountId) {
    throw new TypeError('CLOUDFLARE_ACCOUNT_ID is required for AE SQL')
  }
  const token = config.apiToken.trim()
  if (!token) {
    throw new TypeError('TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN is required for AE SQL')
  }
  const url = `https://api.cloudflare.com/client/v5/accounts/${encodeURIComponent(
    accountId
  )}/analytics_engine/sql`
  const fetchFn = config.fetch ?? fetch
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain',
    },
    body: sql,
    signal: config.signal,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`AE SQL HTTP ${response.status}: ${body.slice(0, 500)}`)
  }
  return parseCloudflareV5SqlResponse(await response.json())
}

/**
 * Thin reusable client over the raw SQL endpoint — same validation and
 * envelope parsing as every query helper in this module, for callers that
 * need to run a pre-built statement.
 */
export class CloudflareAnalyticsSqlClient {
  readonly #config: CloudflareAnalyticsSqlConfig

  constructor(config: CloudflareAnalyticsSqlConfig) {
    this.#config = config
  }

  executeSql(sql: string): Promise<AnalyticsEngineSqlResult> {
    return executeSql(this.#config, sql)
  }
}

export function parseAeLatestAtMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // AE may return unix seconds or milliseconds.
    return raw > 1e12 ? raw : raw * 1000
  }
  if (typeof raw !== 'string' || raw.length === 0) return null
  const match = BACKEND_UTC_DATETIME_RE.exec(raw)
  const normalized = match === null ? raw : `${match[1]}T${match[2]}Z`
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Backend DateTime without timezone: `YYYY-MM-DD HH:MM:SS` or
 * `YYYY-MM-DD HH:MM:SS.SSS`. Must be treated as UTC — engines may otherwise
 * parse the space-separated form as local time.
 */
const BACKEND_UTC_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)$/

/** Cap on serverIds accepted into one fleet-snapshot `IN (...)` list. */
export const MAX_FLEET_SNAPSHOT_SERVERS = 500

/** Quote + validate a non-empty list of server UUIDs for an SQL `IN (...)`. */
export function quoteServerIdInList(serverIds: readonly string[]): string {
  if (serverIds.length === 0) {
    throw new TypeError('serverIds must be non-empty for fleet snapshot SQL')
  }
  if (serverIds.length > MAX_FLEET_SNAPSHOT_SERVERS) {
    throw new TypeError(
      `serverIds length ${serverIds.length} exceeds max ${MAX_FLEET_SNAPSHOT_SERVERS}`
    )
  }
  const seen = new Set<string>()
  const quoted: string[] = []
  for (const raw of serverIds) {
    const id = assertSafeServerId(raw)
    if (seen.has(id)) continue
    seen.add(id)
    quoted.push(quoteSqlStringV5(id))
  }
  if (quoted.length === 0) {
    throw new TypeError('serverIds must be non-empty for fleet snapshot SQL')
  }
  return quoted.join(', ')
}

/**
 * Cap on status-history rows returned to the client. Builders request
 * `MAX_STATUS_EVENTS + 1` so the route can set `truncated`.
 */
export const MAX_STATUS_EVENTS = 1000

const STATUS_TRANSITION_REASONS = new Set<string>([
  'connect',
  'disconnect',
  'sweep_stale',
  'self_heal',
])

function parseStatusConnected(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  const num = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(num)) return null
  return num >= 0.5
}

function parseStatusReason(raw: unknown, connected: boolean): ServerStatusTransitionReason {
  if (typeof raw === 'string' && STATUS_TRANSITION_REASONS.has(raw)) {
    return raw as ServerStatusTransitionReason
  }
  return connected ? 'connect' : 'disconnect'
}

/**
 * Parse generic `{ timestamp, connected, reason }` status rows — shared by
 * the v3-shaped AE status query (historically) and the DuckDB backend's own
 * `server_status_events` reads, which select the identical column aliases.
 */
export function parseStatusEventRows(rows: Array<Record<string, unknown>>): StatusHistoryEvent[] {
  const events: StatusHistoryEvent[] = []
  for (const row of rows) {
    const atMs = parseAeLatestAtMs(row.timestamp)
    if (atMs === null) continue
    const connected = parseStatusConnected(row.connected)
    if (connected === null) continue
    events.push({
      at: new Date(atMs).toISOString(),
      connected,
      reason: parseStatusReason(row.reason, connected),
    })
  }
  return events
}

/**
 * Detect truncation from the raw row count (before parsing), slice to
 * {@link MAX_STATUS_EVENTS}, and derive `knownUntilMs` so uptime math does not
 * extend the last retained state through `to` when later transitions exist.
 */
export function resolveTruncatedStatusEvents(
  rawRows: Array<Record<string, unknown>>,
  fromMs: number
): {
  events: StatusHistoryEvent[]
  truncated: boolean
  knownUntilMs: number | undefined
} {
  const truncated = rawRows.length > MAX_STATUS_EVENTS
  const rows = truncated ? rawRows.slice(0, MAX_STATUS_EVENTS) : rawRows
  const events = parseStatusEventRows(rows)
  if (!truncated) {
    return { events, truncated: false, knownUntilMs: undefined }
  }
  const lastAt = events.length > 0 ? Date.parse(events.at(-1)!.at) : Number.NaN
  const knownUntilMs = Number.isFinite(lastAt) ? lastAt : fromMs
  return { events, truncated: true, knownUntilMs }
}

/**
 * Fleet liveness window for the offline-sweep cron: three missed ~60s host
 * samples. Kept tight so genuinely-dead servers become "suspect" (and get a
 * `checkLiveness` DO wake) quickly; a slightly-stale-but-alive server just
 * costs one extra wake (safe).
 */
export const AE_LIVENESS_WINDOW_SECONDS = 180

/** Hard deadline for the offline-sweep AE liveness SQL read. */
export const AE_LIVENESS_QUERY_TIMEOUT_MS = 5_000

/**
 * Fleet-wide v5 AE SQL: serverIds that emitted a `host.system` row within
 * `sinceSeconds`. Scoped to `host.system` (the universal-baseline family
 * every sample writes exactly once) so each logical sample is one row — no
 * v3-style physical-part recombination needed. No per-server filter — one
 * query covers the whole fleet; AE SQL's default row cap (~10000) means
 * overflow servers are simply treated as "suspect" by the offline sweep
 * (probed via `checkLiveness` as today) — correctness is preserved.
 */
export function buildRecentlyActiveServerIdsSqlV5(opts: {
  sinceSeconds: number
  nowMs?: number
  dataset?: string
}): string {
  const sinceSeconds = assertPositiveIntV5('sinceSeconds', opts.sinceSeconds)
  const dataset = assertSafeDatasetNameV5(opts.dataset ?? AE_V5_DATASET_NAME)
  const fromUnix = Math.floor((opts.nowMs ?? Date.now()) / 1000) - sinceSeconds
  const discriminators = hostMetricsV5DiscriminatorPredicates()

  return [
    'SELECT',
    `  ${AE_V5_INDEX_SERVER_ID_COLUMN} AS server_id,`,
    `  max(${AE_V5_TIMESTAMP_COLUMN}) AS latest_at`,
    `FROM ${dataset}`,
    `WHERE ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${familyPredicateV5(AE_V5_FAMILY_HOST_SYSTEM)}`,
    `  AND ${AE_V5_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `GROUP BY server_id`,
  ].join('\n')
}

/**
 * Query AE for serverIds with a recent `host.system` sample. Returns a Map of
 * serverId → latest sample timestamp (epoch ms). Empty / unparseable rows are
 * skipped. Callers treat a thrown error as "AE unavailable".
 */
export async function queryRecentlyActiveServerIdsV5(
  config: CloudflareAnalyticsSqlConfig,
  opts: { sinceSeconds: number; signal?: AbortSignal }
): Promise<Map<string, number>> {
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const sql = buildRecentlyActiveServerIdsSqlV5({
    sinceSeconds: opts.sinceSeconds,
    dataset,
  })
  const result = await executeSql({ ...config, signal: opts.signal }, sql)
  const out = new Map<string, number>()
  for (const row of result.data) {
    const serverId = parseAeServerIdV5(row.server_id)
    if (serverId === null) continue
    const latestAtMs = parseAeLatestAtMs(row.latest_at)
    if (latestAtMs === null) continue
    out.set(serverId, latestAtMs)
  }
  return out
}

/**
 * Row-kind + schema-version discriminators for the shared v5 dataset
 * (`kind` is `"metrics"` / `"event"` / `"status"` — see `field-map-v5.ts`'s
 * `AE_V5_BLOB_KIND_INDEX`).
 */
export function v5EventDiscriminatorPredicates(kind: string): string[] {
  const kindCol = blobColumnV5(AE_V5_BLOB_KIND_INDEX)
  const schemaVersionCol = blobColumnV5(AE_V5_BLOB_SCHEMA_VERSION_INDEX)
  const schemaVersions = AE_V5_SUPPORTED_SCHEMA_VERSIONS.map((version) =>
    quoteSqlStringV5(String(version))
  )
  const schemaPredicate =
    schemaVersions.length === 1
      ? `${schemaVersionCol} = ${schemaVersions[0]}`
      : `${schemaVersionCol} IN (${schemaVersions.join(', ')})`
  return [`${kindCol} = ${quoteSqlStringV5(kind)}`, schemaPredicate]
}

/** `"metrics"`-kind row discriminators (`blob1 = 'metrics'` + schema version). */
export function hostMetricsV5DiscriminatorPredicates(): string[] {
  return v5EventDiscriminatorPredicates(AE_V5_KIND_METRICS)
}

/** `"event"`-kind row discriminators. */
export function eventV5DiscriminatorPredicates(): string[] {
  return v5EventDiscriminatorPredicates(AE_V5_KIND_EVENT)
}

/** `"status"`-kind row discriminators. */
export function statusV5DiscriminatorPredicates(): string[] {
  return v5EventDiscriminatorPredicates(AE_V5_KIND_STATUS)
}

/** `blob2 = '<family>'` predicate scoping an aggregate to one hosted family. */
export function familyPredicateV5(family: HostedFamilyV5): string {
  return `${blobColumnV5(AE_V5_BLOB_FAMILY_INDEX)} = ${quoteSqlStringV5(family)}`
}

/**
 * AE SQL literal matching write-path `AE_V5_MISSING_METRIC_SENTINEL`
 * (`-1e308`). AE SQL docs only list plain decimal literals — not scientific
 * notation — so `pow(10, 308)` stands in, same idiom as v3.
 */
export function aeV5MissingMetricSentinelSql(): string {
  return '-pow(10, 308)'
}

/**
 * Any parsed metric value at or below this is the missing-metric sentinel.
 * Threshold, not equality: the SQL-side sentinel is `-pow(10, 308)` and must
 * match after float round-trips. Same threshold as v3.
 */
const AE_V5_SENTINEL_STRIP_THRESHOLD = -1e307

/** Report a still-sentinel result as missing, never a number. */
export function stripAeV5Sentinel(value: number): number | null {
  return value <= AE_V5_SENTINEL_STRIP_THRESHOLD ? null : value
}

/**
 * Interval-and-sampling-weighted average for one host.system/host.io column,
 * scoped to its owning family and excluding missing-metric sentinel rows:
 *
 *   SUM(value * double20 * _sample_interval) / SUM(double20 * _sample_interval)
 *
 * Unlike v3, no cross-row recombination is needed first — `family` already
 * identifies the one row per sample that carries this column.
 */
export function weightedAvgExpressionForColumnV5(
  family: HostedFamilyV5,
  doubleIndex: number
): string {
  const col = doubleColumnV5(doubleIndex)
  const familyPred = familyPredicateV5(family)
  const sentinel = aeV5MissingMetricSentinelSql()
  const weight = `${intervalSecondsColumnV5()} * _sample_interval`
  const numerator = `SUM(if(${familyPred}, if(${col} = ${sentinel}, 0.0, ${col} * ${weight}), 0.0))`
  const denominator = `SUM(if(${familyPred}, if(${col} = ${sentinel}, 0.0, ${weight} * 1.0), 0.0))`
  return `${numerator} / ${denominator}`
}

/**
 * Delta-sum aggregate for a monotonic-counter-derived column: the raw
 * per-interval delta weighted only by AE's own `_sample_interval` — never by
 * `intervalSeconds` (double20), since the delta already totals its own
 * collection interval. Same rationale as v3's `sum` aggregation.
 */
export function deltaSumExpressionForColumnV5(family: HostedFamilyV5, doubleIndex: number): string {
  const col = doubleColumnV5(doubleIndex)
  const familyPred = familyPredicateV5(family)
  const sentinel = aeV5MissingMetricSentinelSql()
  return `SUM(if(${familyPred}, if(${col} = ${sentinel}, 0.0, ${col} * _sample_interval), 0.0))`
}

/** `max` aggregate for one host.system/host.io column, scoped to its family. */
export function maxValueExpressionForColumnV5(family: HostedFamilyV5, doubleIndex: number): string {
  const col = doubleColumnV5(doubleIndex)
  const familyPred = familyPredicateV5(family)
  const sentinel = aeV5MissingMetricSentinelSql()
  return `MAX(if(${familyPred}, ${col}, ${sentinel}))`
}

/**
 * `last` aggregate for one host.system/host.io column: `argMax` keyed by the
 * row's own ingestion timestamp, with sentinel/other-family rows demoted to
 * ordering key `0` so any real observation always outranks them.
 */
export function lastValueExpressionForColumnV5(
  family: HostedFamilyV5,
  doubleIndex: number
): string {
  const col = doubleColumnV5(doubleIndex)
  const familyPred = familyPredicateV5(family)
  const sentinel = aeV5MissingMetricSentinelSql()
  const rawValue = `if(${familyPred}, ${col}, ${sentinel})`
  const tsExpr = `toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN})`
  return `argMax(${rawValue}, if(${rawValue} = ${sentinel}, ${tsExpr} * 0, ${tsExpr}))`
}

/**
 * Underlying-sample weight for a bucket/group, anchored on `host.system` —
 * every sample always writes exactly one `host.system` row, so this can
 * never double-count the way counting more than one v3 part would.
 */
export function sampleCountExpressionV5(): string {
  return `SUM(if(${familyPredicateV5(AE_V5_FAMILY_HOST_SYSTEM)}, _sample_interval * 1.0, 0.0))`
}

/** Latest observed sample timestamp (unix seconds) for a bucket/group, anchored on `host.system`. */
export function latestAtExpressionV5(): string {
  return `MAX(if(${familyPredicateV5(
    AE_V5_FAMILY_HOST_SYSTEM
  )}, toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN}), 0))`
}

/** Canonical half-open `[fromUnix, toUnix)` time-range predicate — matches v3 and `computeSeriesGapCount`'s coverage grid. */
export function timeRangePredicateV5(fromUnix: number, toUnix: number): string {
  return `${AE_V5_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix}) AND ${AE_V5_TIMESTAMP_COLUMN} < toDateTime(${toUnix})`
}

/** `index1 = '<serverId>'` predicate for the AE v5 dataset. */
export function serverIdPredicateV5(serverId: string): string {
  return `${AE_V5_INDEX_SERVER_ID_COLUMN} = ${quoteSqlStringV5(serverId)}`
}

/**
 * Predicate matching a paged row whose blob10 identity list (comma-joined
 * entity ids, same order as the page's doubles — see `field-map-v5.ts`'s
 * module doc comment) contains `entityId`, whether that id is the row's only
 * entity or one of several sharing the page. AE SQL has no documented array
 * function to lean on here, so this matches the CSV list positionally
 * (exact single-id match, or a comma-delimited substring match at either
 * edge or in the middle) rather than parsing it.
 */
export function entityIdInPageIdentityPredicateV5(entityId: string): string {
  const col = blobColumnV5(AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX)
  const id = quoteSqlStringV5(entityId)
  const prefix = quoteSqlStringV5(`${entityId},`)
  const suffix = quoteSqlStringV5(`,${entityId}`)
  const middle = quoteSqlStringV5(`,${entityId},`)
  return `(${col} = ${id} OR ${col} LIKE CONCAT(${prefix}, '%') OR ${col} LIKE CONCAT('%', ${suffix}) OR ${col} LIKE CONCAT('%', ${middle}, '%'))`
}

export { assertSafeDatasetNameV5 }

// ---------------------------------------------------------------------------
// Status history — see the module doc comment for why this query is in
// scope while the paged-family series/summary queries are not.
// ---------------------------------------------------------------------------

function buildStatusEventsSqlV5(
  input: StatusHistoryQuery,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = statusV5DiscriminatorPredicates()
  const connectedCol = statusConnectedColumnV5()
  const reasonCol = statusReasonColumnV5()
  const limit = MAX_STATUS_EVENTS + 1

  return [
    'SELECT',
    `  ${AE_V5_TIMESTAMP_COLUMN} AS timestamp,`,
    `  ${connectedCol} AS connected,`,
    `  ${reasonCol} AS reason`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_V5_TIMESTAMP_COLUMN} >= toDateTime(${fromUnix})`,
    `  AND ${AE_V5_TIMESTAMP_COLUMN} < toDateTime(${toUnix})`,
    `ORDER BY ${AE_V5_TIMESTAMP_COLUMN} ASC`,
    `LIMIT ${limit}`,
  ].join('\n')
}

/**
 * State just before `from` — `ORDER BY … DESC LIMIT 1` rather than `argMax`,
 * same rationale as v3's `buildStatusPriorStateSql`.
 */
function buildStatusPriorStateSqlV5(
  input: StatusHistoryQuery,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const discriminators = statusV5DiscriminatorPredicates()
  const connectedCol = statusConnectedColumnV5()
  const reasonCol = statusReasonColumnV5()

  return [
    'SELECT',
    `  ${AE_V5_TIMESTAMP_COLUMN} AS timestamp,`,
    `  ${connectedCol} AS connected,`,
    `  ${reasonCol} AS reason`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${AE_V5_TIMESTAMP_COLUMN} < toDateTime(${fromUnix})`,
    `ORDER BY ${AE_V5_TIMESTAMP_COLUMN} DESC`,
    `LIMIT 1`,
  ].join('\n')
}

/**
 * Real v5 status-history query — mirrors v3's `queryStatusHistoryViaSqlApi`
 * exactly (same uptime math via the shared `computeStatusUptime`), scoped to
 * the v5 dataset's `"status"`-kind rows.
 */
export async function queryStatusHistoryViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: StatusHistoryQuery
): Promise<StatusHistoryResult> {
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const client = new CloudflareAnalyticsSqlClient(config)
  const priorSql = buildStatusPriorStateSqlV5(input, {
    dataset,
    maxRangeSeconds,
  })
  const eventsSql = buildStatusEventsSqlV5(input, { dataset, maxRangeSeconds })

  const [priorResult, eventsResult] = await Promise.all([
    client.executeSql(priorSql),
    client.executeSql(eventsSql),
  ])

  const priorConnected = parseStatusConnected(priorResult.data[0]?.connected)
  const fromMs = Date.parse(input.from)
  const toMs = Date.parse(input.to)
  const { events, truncated, knownUntilMs } = resolveTruncatedStatusEvents(
    eventsResult.data,
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
    kind: 'analytics-engine',
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

// ---------------------------------------------------------------------------
// Host series / summary / fleet snapshot / metric events — host.system and
// host.io are each a single row per sample (no v3-style cross-part
// recombination needed), so these query directly off the raw dataset.
// ---------------------------------------------------------------------------

/**
 * Dispatch a descriptor's declared `aggregation` to the matching column
 * expression builder — the single place a query builder needs to know which
 * of the four aggregation kinds a requested metric uses.
 */
export function aggregateExpressionForDescriptorV5(
  descriptor: HostMetricsMetricDescriptorV5,
  family: HostedFamilyV5,
  doubleIndex: number
): string {
  switch (descriptor.aggregation) {
    case 'weighted-average':
      return weightedAvgExpressionForColumnV5(family, doubleIndex)
    case 'delta-sum':
      return deltaSumExpressionForColumnV5(family, doubleIndex)
    case 'max':
      return maxValueExpressionForColumnV5(family, doubleIndex)
    case 'last':
      return lastValueExpressionForColumnV5(family, doubleIndex)
    default: {
      const exhaustive: never = descriptor.aggregation
      throw new TypeError(`unhandled v5 metric aggregation: ${exhaustive}`)
    }
  }
}

/** Positional column alias — canonical names contain dots, so requested metrics are aliased `m0`, `m1`, ... rather than by name. */
function metricAliasV5(index: number): string {
  return `m${index}`
}

/** Host-singleton entity scopes queryable via `queryHostSeries` — `host.*` plus the capability-gated `cpuDetail`/`memoryDetail` scalar scopes. */
const HOST_SERIES_QUERYABLE_SCOPES_V5: ReadonlySet<MetricEntityScopeV5> = new Set([
  'host.cpu',
  'host.kernel',
  'host.memory',
  'host.storage',
  'host.network',
  'cpuDetail',
  'memoryDetail',
])

/** Validate `metrics` are known canonical names scoped to a queryable host-singleton entity, de-duplicated, in request order. */
function assertHostMetricsV5(metrics: readonly string[]): string[] {
  if (metrics.length === 0) {
    throw new TypeError('metrics must be non-empty')
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of metrics) {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[name]
    if (!descriptor || !HOST_SERIES_QUERYABLE_SCOPES_V5.has(descriptor.entityScope)) {
      throw new TypeError(`unknown or non-host v5 metric canonicalName: ${name}`)
    }
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

/** `true` when any of `metrics` resolves to a `cpu.detail`/`memory.detail` field, requiring those families' rows in the scan. */
function requiresDetailFamilyV5(metrics: readonly string[], family: HostedFamilyV5): boolean {
  return metrics.some((name) => {
    const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[name]
    if (!descriptor) return false
    if (descriptor.entityScope !== 'cpuDetail' && descriptor.entityScope !== 'memoryDetail') {
      return false
    }
    return doubleIndexForHostField(descriptor.entityScope, descriptor.fieldName).family === family
  })
}

function hostMetricSelectExpressionV5(canonicalName: string, alias: string): string {
  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[canonicalName]
  const { family, doubleIndex } = doubleIndexForHostField(
    descriptor.entityScope,
    descriptor.fieldName
  )
  return `${aggregateExpressionForDescriptorV5(descriptor, family, doubleIndex)} AS ${alias}`
}

/**
 * `blob1 = 'metrics' AND (blob2 = 'host.system' OR blob2 = 'host.io' [OR ...])`
 * — every host-metric select's internal `if()` guards already scope by
 * family, this is a row-scan optimization, not a correctness requirement.
 * `host.system`/`host.io` are always included (the former anchors
 * `sample_count`); `cpu.detail`/`memory.detail` are included only when
 * `metrics` actually references one of their fields, so a request that never
 * touches those capability-gated families doesn't pay to scan their rows.
 */
function hostFamilyScopePredicateV5(metrics: readonly string[]): string {
  const families: HostedFamilyV5[] = [AE_V5_FAMILY_HOST_SYSTEM, AE_V5_FAMILY_HOST_IO]
  if (requiresDetailFamilyV5(metrics, AE_V5_FAMILY_CPU_DETAIL)) {
    families.push(AE_V5_FAMILY_CPU_DETAIL)
  }
  if (requiresDetailFamilyV5(metrics, AE_V5_FAMILY_MEMORY_DETAIL)) {
    families.push(AE_V5_FAMILY_MEMORY_DETAIL)
  }
  return `(${families.map(familyPredicateV5).join(' OR ')})`
}

function parseHostMetricValuesV5(
  metrics: readonly string[],
  aliases: readonly string[],
  row: Record<string, unknown>
): Partial<Record<string, number | null>> {
  const values: Partial<Record<string, number | null>> = {}
  metrics.forEach((name, i) => {
    const raw = row[aliases[i]]
    if (raw === null || raw === undefined) {
      values[name] = null
      return
    }
    const num = typeof raw === 'number' ? raw : Number(raw)
    values[name] = Number.isFinite(num) ? stripAeV5Sentinel(num) : null
  })
  return values
}

/**
 * A bucket/group's topology generation is the single value shared by every
 * contributing `host.system` row, or `null` when unknown (no rows) or mixed
 * (a reassignment happened inside the window). `MIN`/`MAX` over the raw
 * string blob are compared for equality only, never numeric order — same
 * discipline as v3's `parseBucketHardwareProfileGeneration`.
 */
function parseTopologyGenerationV5(row: Record<string, unknown>): number | null {
  const min = row.topology_gen_min
  const max = row.topology_gen_max
  if (min === null || min === undefined || max === null || max === undefined) {
    return null
  }
  if (typeof min !== 'string' && typeof min !== 'number') return null
  if (typeof max !== 'string' && typeof max !== 'number') return null
  if (String(min) !== String(max)) return null
  const num = typeof min === 'number' ? min : Number(min)
  return Number.isFinite(num) ? num : null
}

function parseBucketEpochSecondsV5(bucket: unknown): number {
  if (typeof bucket === 'number') return bucket
  if (typeof bucket === 'string') return Number(bucket)
  return Number.NaN
}

function buildHostSeriesSqlV5(
  input: HostSeriesQueryV5,
  opts: { dataset: string; maxRangeSeconds: number }
): {
  sql: string
  metrics: string[]
  aliases: string[]
  bucketSeconds: number
} {
  const serverId = assertSafeServerId(input.serverId)
  const metrics = assertHostMetricsV5(input.metrics)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  const bucketSeconds = assertPositiveIntV5(
    'resolutionSeconds',
    input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS
  )
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const aliases = metrics.map((_, i) => metricAliasV5(i))
  const metricSelects = metrics.map((name, i) => hostMetricSelectExpressionV5(name, aliases[i]))
  const generationCol = blobColumnV5(AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX)
  const hostSystemPred = familyPredicateV5(AE_V5_FAMILY_HOST_SYSTEM)
  const allSelects = metricSelects

  const sql = [
    'SELECT',
    `  intDiv(toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN}), ${bucketSeconds}) * ${bucketSeconds} AS bucket,`,
    `  ${sampleCountExpressionV5()} AS sample_count,`,
    `  SUM(if(${hostSystemPred}, ${intervalSecondsColumnV5()} * _sample_interval, 0.0)) / ${sampleCountExpressionV5()} AS avg_interval_seconds,`,
    // Plain MIN/MAX, no if()-guard needed: WHERE already scopes every row to
    // host.system/host.io, and both of one sample's rows carry the identical
    // blob7 (topology generation) value — see field-map-v5.ts's
    // buildV5MetricsBlobs, which stamps it on every metrics-kind row.
    `  MIN(${generationCol}) AS topology_gen_min,`,
    `  MAX(${generationCol}) AS topology_gen_max,`,
    `  ${allSelects.join(',\n  ')}`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${hostFamilyScopePredicateV5(metrics)}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `GROUP BY bucket`,
    `ORDER BY bucket ASC`,
  ].join('\n')

  return { sql, metrics, aliases, bucketSeconds }
}

/**
 * Distinct topology generations observed anywhere in a server's queried
 * range, scoped to `host.system` (every sample writes exactly one). Paired
 * with {@link buildHostSeriesSqlV5} by {@link queryHostSeriesViaSqlApiV5} to
 * populate `HostSeriesResultV5.topologyGenerations`.
 */
function buildTopologyGenerationsSqlV5(
  input: HostSeriesQueryV5,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const generationCol = blobColumnV5(AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX)

  return [
    'SELECT',
    `  ${generationCol} AS generation`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${familyPredicateV5(AE_V5_FAMILY_HOST_SYSTEM)}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `GROUP BY generation`,
  ].join('\n')
}

function parseTopologyGenerationsRowsV5(data: Array<Record<string, unknown>>): number[] {
  const generations = new Set<number>()
  for (const row of data) {
    const raw = row.generation
    const num = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(num)) generations.add(num)
  }
  return [...generations].sort((a, b) => a - b)
}

function parseHostSeriesRowsV5(
  metrics: readonly string[],
  aliases: readonly string[],
  data: Array<Record<string, unknown>>,
  resolutionSeconds: number
): { points: HostSeriesResultV5['points']; sampleCount: number } {
  const points: HostSeriesResultV5['points'] = []
  let sampleCount = 0
  for (const row of data) {
    const bucketEpochSeconds = parseBucketEpochSecondsV5(row.bucket)
    if (!Number.isFinite(bucketEpochSeconds)) continue

    const rowSamples = Number(row.sample_count ?? 0)
    const hasSamples = Number.isFinite(rowSamples) && rowSamples > 0
    // No SQL HAVING filter (see buildHostSeriesSqlV5) — a bucket whose only
    // rows are an orphaned host.io write with no matching host.system row
    // (sampleCountExpressionV5 is host.system-anchored) is skipped here
    // instead, same effect as v3's WHERE-wrapped-subquery idiom.
    if (!hasSamples) continue
    sampleCount += rowSamples

    const avgIntervalSeconds = Number(row.avg_interval_seconds)
    const expectedSampleCount = Number.isFinite(avgIntervalSeconds)
      ? defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)
      : defaultExpectedSamplesPerBucket(resolutionSeconds)

    points.push({
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values: parseHostMetricValuesV5(metrics, aliases, row),
      sampleCount: hasSamples ? rowSamples : undefined,
      expectedSampleCount,
      topologyGeneration: parseTopologyGenerationV5(row),
    })
  }
  return { points, sampleCount }
}

export async function queryHostSeriesViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: HostSeriesQueryV5
): Promise<HostSeriesResultV5> {
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const { sql, metrics, aliases, bucketSeconds } = buildHostSeriesSqlV5(input, {
    dataset,
    maxRangeSeconds,
  })
  const generationsSql = buildTopologyGenerationsSqlV5(input, {
    dataset,
    maxRangeSeconds,
  })
  const client = new CloudflareAnalyticsSqlClient(config)
  const [seriesResult, generationsResult] = await Promise.all([
    client.executeSql(sql),
    client.executeSql(generationsSql),
  ])
  const { points, sampleCount } = parseHostSeriesRowsV5(
    metrics,
    aliases,
    seriesResult.data,
    bucketSeconds
  )
  const topologyGenerations = parseTopologyGenerationsRowsV5(generationsResult.data)
  return finalizeHostSeriesResultV5(input.from, input.to, {
    kind: 'analytics-engine',
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

function buildHostSummarySqlV5(
  input: HostSummaryQueryV5,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()

  return [
    'SELECT',
    `  ${sampleCountExpressionV5()} AS sample_count,`,
    `  ${latestAtExpressionV5()} AS latest_at`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    // Host summary never selects `cpu.detail`/`memory.detail` fields (it only
    // counts/dates samples), so the scan never needs those families.
    `  AND ${hostFamilyScopePredicateV5([])}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
  ].join('\n')
}

function parseHostSummaryRowV5(row: Record<string, unknown> | undefined): {
  sampleCount: number
  latestAt: string | null
} {
  const sampleCountRaw = Number(row?.sample_count ?? 0)
  const sampleCount = Number.isFinite(sampleCountRaw) ? sampleCountRaw : 0
  if (sampleCount <= 0) {
    return { sampleCount, latestAt: null }
  }
  const latestAtMs = parseAeLatestAtMs(row?.latest_at)
  return {
    sampleCount,
    latestAt: latestAtMs === null ? null : new Date(latestAtMs).toISOString(),
  }
}

export async function queryHostSummaryViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: HostSummaryQueryV5
): Promise<HostSummaryResultV5> {
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const sql = buildHostSummarySqlV5(input, { dataset, maxRangeSeconds })
  const client = new CloudflareAnalyticsSqlClient(config)
  const result = await client.executeSql(sql)
  const { sampleCount, latestAt } = parseHostSummaryRowV5(result.data[0])
  return {
    kind: 'analytics-engine',
    available: true,
    serverId: input.serverId,
    sampleCount,
    latestAt,
  }
}

function buildFleetHostSnapshotSqlV5(
  input: FleetHostSnapshotQueryV5,
  opts: { dataset: string; maxRangeSeconds: number }
): { sql: string; metrics: string[]; aliases: string[] } {
  const metrics = assertHostMetricsV5(input.metrics)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)
  const inList = quoteServerIdInList(input.serverIds)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const aliases = metrics.map((_, i) => metricAliasV5(i))
  const metricSelects = metrics.map((name, i) => hostMetricSelectExpressionV5(name, aliases[i]))
  const generationCol = blobColumnV5(AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX)

  const sql = [
    'SELECT',
    `  ${AE_V5_INDEX_SERVER_ID_COLUMN} AS server_id,`,
    `  ${sampleCountExpressionV5()} AS sample_count,`,
    `  ${latestAtExpressionV5()} AS latest_at,`,
    // Plain MIN/MAX, no if()-guard needed: WHERE already scopes every row to
    // host.system/host.io, and both of one sample's rows carry the identical
    // blob7 (topology generation) value — see field-map-v5.ts's
    // buildV5MetricsBlobs, which stamps it on every metrics-kind row.
    `  MIN(${generationCol}) AS topology_gen_min,`,
    `  MAX(${generationCol}) AS topology_gen_max,`,
    `  ${metricSelects.join(',\n  ')}`,
    `FROM ${opts.dataset}`,
    `WHERE ${AE_V5_INDEX_SERVER_ID_COLUMN} IN (${inList})`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${hostFamilyScopePredicateV5(metrics)}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `GROUP BY server_id`,
  ].join('\n')

  return { sql, metrics, aliases }
}

function parseFleetHostSnapshotRowsV5(
  metrics: readonly string[],
  aliases: readonly string[],
  data: Array<Record<string, unknown>>
): FleetHostSnapshotServerV5[] {
  const servers: FleetHostSnapshotServerV5[] = []
  for (const row of data) {
    const serverId = parseAeServerIdV5(row.server_id)
    if (serverId === null) continue
    const sampleCountRaw = Number(row.sample_count ?? 0)
    const sampleCount = Number.isFinite(sampleCountRaw) ? sampleCountRaw : 0
    // No SQL HAVING filter (see buildFleetHostSnapshotSqlV5) — a server with
    // only an orphaned host.io row (no matching host.system row) is skipped
    // here instead, same effect as v3's WHERE-wrapped-subquery idiom.
    if (sampleCount <= 0) continue
    const latestAtMs = parseAeLatestAtMs(row.latest_at)
    servers.push({
      serverId,
      sampleCount,
      latestAt: latestAtMs === null || sampleCount <= 0 ? null : new Date(latestAtMs).toISOString(),
      values: parseHostMetricValuesV5(metrics, aliases, row),
      topologyGeneration: parseTopologyGenerationV5(row),
    })
  }
  servers.sort((a, b) => a.serverId.localeCompare(b.serverId))
  return servers
}

export async function queryFleetHostSnapshotViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: FleetHostSnapshotQueryV5
): Promise<FleetHostSnapshotResultV5> {
  if (input.serverIds.length === 0) {
    return {
      kind: 'analytics-engine',
      available: true,
      metrics: [...input.metrics],
      servers: [],
    }
  }
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const { sql, metrics, aliases } = buildFleetHostSnapshotSqlV5(input, {
    dataset,
    maxRangeSeconds,
  })
  const client = new CloudflareAnalyticsSqlClient(config)
  const result = await client.executeSql(sql)
  return {
    kind: 'analytics-engine',
    available: true,
    metrics,
    servers: parseFleetHostSnapshotRowsV5(metrics, aliases, result.data),
  }
}

// ---------------------------------------------------------------------------
// Metric events (`sample.events`) — `"event"`-kind rows, capped like status history.
// ---------------------------------------------------------------------------

const EVENT_SEVERITIES_V5 = new Set<string>(['info', 'warning', 'critical'])

function parseEventSeverityV5(raw: unknown): MetricEventSeverityV5 {
  return typeof raw === 'string' && EVENT_SEVERITIES_V5.has(raw)
    ? (raw as MetricEventSeverityV5)
    : 'info'
}

function optionalNonEmptyStringV5(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw
}

function parseEventPayloadV5(raw: unknown): MetricEventV5['payload'] {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as MetricEventV5['payload']
  } catch {
    return undefined
  }
}

function parseMetricEventRowV5(row: Record<string, unknown>): MetricEventV5 | null {
  const atMs = parseAeLatestAtMs(row.timestamp)
  if (atMs === null) return null
  const eventId = typeof row.event_id === 'string' ? row.event_id : ''
  const kind = typeof row.kind === 'string' ? row.kind : ''
  if (eventId.length === 0 || kind.length === 0) return null
  const event: MetricEventV5 = {
    eventId,
    at: new Date(atMs).toISOString(),
    kind: kind as MetricEventKindV5,
    severity: parseEventSeverityV5(row.severity),
  }
  const entityId = optionalNonEmptyStringV5(row.entity_id)
  if (entityId !== undefined) event.entityId = entityId
  const source = optionalNonEmptyStringV5(row.source)
  if (source !== undefined) event.source = source
  const payload = parseEventPayloadV5(row.payload)
  if (payload !== undefined) event.payload = payload
  return event
}

function parseMetricEventRowsV5(rawRows: Array<Record<string, unknown>>): {
  events: MetricEventV5[]
  truncated: boolean
} {
  const truncated = rawRows.length > MAX_STATUS_EVENTS
  const rows = truncated ? rawRows.slice(0, MAX_STATUS_EVENTS) : rawRows
  const events: MetricEventV5[] = []
  for (const row of rows) {
    const event = parseMetricEventRowV5(row)
    if (event === null) continue
    events.push(event)
  }
  return { events, truncated }
}

function buildMetricEventsSqlV5(
  input: MetricEventsQueryV5,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = eventV5DiscriminatorPredicates()
  const limit = MAX_STATUS_EVENTS + 1

  return [
    'SELECT',
    `  ${AE_V5_TIMESTAMP_COLUMN} AS timestamp,`,
    `  ${blobColumnV5(AE_V5_BLOB_EVENT_ID_INDEX)} AS event_id,`,
    `  ${blobColumnV5(AE_V5_BLOB_FAMILY_INDEX)} AS kind,`,
    `  ${statusReasonColumnV5()} AS severity,`,
    `  ${blobColumnV5(AE_V5_BLOB_EVENT_ENTITY_ID_INDEX)} AS entity_id,`,
    `  ${blobColumnV5(AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX)} AS source,`,
    `  ${blobColumnV5(AE_V5_BLOB_EVENT_PAYLOAD_INDEX)} AS payload`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `ORDER BY ${AE_V5_TIMESTAMP_COLUMN} ASC`,
    `LIMIT ${limit}`,
  ].join('\n')
}

export async function queryMetricEventsViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: MetricEventsQueryV5
): Promise<MetricEventsResultV5> {
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const sql = buildMetricEventsSqlV5(input, { dataset, maxRangeSeconds })
  const client = new CloudflareAnalyticsSqlClient(config)
  const result = await client.executeSql(sql)
  const { events, truncated } = parseMetricEventRowsV5(result.data)
  return {
    kind: 'analytics-engine',
    available: true,
    serverId: input.serverId,
    events,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Entity series / entity-ids-seen — per-entity families. See the module doc
// comment for why paged families (gpu/network/filesystem/block/
// hardware.physical) need cross-row TypeScript recombination while the two
// single-row-per-entity managed families don't.
// ---------------------------------------------------------------------------

const SINGLE_ROW_FAMILIES_V5 = new Set<PerEntityHostedFamilyV5>([
  'managed.ingress',
  'managed.database_proxy',
])

/** `PerEntityHostedFamilyV5` -> the `MetricEntityScopeV5` its bare field names are qualified under in `HOST_METRICS_METRIC_DESCRIPTORS_V5`. */
const ENTITY_SCOPE_FOR_FAMILY_V5: Record<PerEntityHostedFamilyV5, MetricEntityScopeV5> = {
  gpu: 'gpu',
  network: 'network',
  filesystem: 'filesystem',
  block: 'block',
  'hardware.physical': 'hardwareSignal',
  'managed.ingress': 'ingress',
  'managed.database_proxy': 'databaseProxy',
}

function fieldOrderForFamilyV5(family: PerEntityHostedFamilyV5): readonly string[] {
  if (family === 'managed.ingress' || family === 'managed.database_proxy') {
    return SINGLE_ROW_FIELD_ORDER_V5[family]
  }
  return PER_ENTITY_FIELD_ORDER_V5[family]
}

function resolveEntityFieldDescriptorV5(
  family: PerEntityHostedFamilyV5,
  field: string
): HostMetricsMetricDescriptorV5 {
  const canonicalName = `${ENTITY_SCOPE_FOR_FAMILY_V5[family]}.${field}`
  const descriptor = HOST_METRICS_METRIC_DESCRIPTORS_V5[canonicalName]
  if (!descriptor) {
    throw new TypeError(`unknown v5 metric field "${field}" for family "${family}"`)
  }
  return descriptor
}

/** Validate + de-dupe requested bare field names, in request order. */
function assertEntityFieldsV5(
  family: PerEntityHostedFamilyV5,
  fields: readonly string[]
): string[] {
  if (fields.length === 0) {
    throw new TypeError('metrics must be non-empty')
  }
  const order = fieldOrderForFamilyV5(family)
  const seen = new Set<string>()
  const result: string[] = []
  for (const field of fields) {
    if (!order.includes(field)) {
      throw new TypeError(`unknown v5 metric field "${field}" for family "${family}"`)
    }
    if (seen.has(field)) continue
    seen.add(field)
    result.push(field)
  }
  return result
}

/** Validate + de-dupe requested entity ids, in request order. */
function assertEntityIdsV5(entityIds: readonly string[]): string[] {
  if (entityIds.length === 0) {
    throw new TypeError('entityIds must be non-empty')
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of entityIds) {
    if (!id) throw new TypeError('entityIds must not contain an empty string')
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/** Per-(bucket, entity, field) accumulator across every contributing group row. */
type EntityFieldAccumulatorV5 =
  | { aggregation: 'weighted-average'; numerator: number; denominator: number }
  | { aggregation: 'delta-sum'; raw: number }
  | { aggregation: 'max'; raw: number }
  | { aggregation: 'last'; value: number; key: number }

type BucketEntityAccumulatorV5 = {
  sampleCount: number
  /** Reconstructed `SUM(interval * weight)` — see {@link mergeIntervalWeightedSumV5}. */
  intervalWeightedSum: number
  fields: Map<string, EntityFieldAccumulatorV5>
}

function mergeFieldAccumulatorV5(
  existing: EntityFieldAccumulatorV5 | undefined,
  aggregation: HostMetricsMetricDescriptorV5['aggregation'],
  raw: {
    numerator?: number
    denominator?: number
    raw?: number
    value?: number
    key?: number
  }
): EntityFieldAccumulatorV5 {
  switch (aggregation) {
    case 'weighted-average': {
      const prev = existing?.aggregation === 'weighted-average' ? existing : undefined
      return {
        aggregation: 'weighted-average',
        numerator: (prev?.numerator ?? 0) + (raw.numerator ?? 0),
        denominator: (prev?.denominator ?? 0) + (raw.denominator ?? 0),
      }
    }
    case 'delta-sum': {
      const prev = existing?.aggregation === 'delta-sum' ? existing : undefined
      return {
        aggregation: 'delta-sum',
        raw: (prev?.raw ?? 0) + (raw.raw ?? 0),
      }
    }
    case 'max': {
      const prev = existing?.aggregation === 'max' ? existing : undefined
      const nextRaw = raw.raw ?? aeV5MissingSentinelValue()
      return {
        aggregation: 'max',
        raw: prev === undefined ? nextRaw : Math.max(prev.raw, nextRaw),
      }
    }
    case 'last': {
      const prev = existing?.aggregation === 'last' ? existing : undefined
      const nextKey = raw.key ?? 0
      const nextValue = raw.value ?? aeV5MissingSentinelValue()
      if (prev === undefined || nextKey > prev.key) {
        return { aggregation: 'last', value: nextValue, key: nextKey }
      }
      return prev
    }
  }
}

const AE_V5_MISSING_SENTINEL_JS = -Math.pow(10, 308)

/** The JS-side numeric sentinel matching AE SQL's `-pow(10, 308)` literal. */
function aeV5MissingSentinelValue(): number {
  return AE_V5_MISSING_SENTINEL_JS
}

function finalizeFieldAccumulatorV5(acc: EntityFieldAccumulatorV5 | undefined): number | null {
  if (acc === undefined) return null
  switch (acc.aggregation) {
    case 'weighted-average':
      return acc.denominator > 0 ? stripAeV5Sentinel(acc.numerator / acc.denominator) : null
    case 'delta-sum':
      return acc.raw
    case 'max':
      return stripAeV5Sentinel(acc.raw)
    case 'last':
      return stripAeV5Sentinel(acc.value)
  }
}

/** `groupAvgIntervalSeconds * groupSampleCount` reconstructs that group's own `SUM(interval * weight)`, summable across groups before a final division. */
function mergeIntervalWeightedSumV5(
  groupAvgIntervalSeconds: unknown,
  groupSampleCount: number
): number {
  const avg =
    typeof groupAvgIntervalSeconds === 'number'
      ? groupAvgIntervalSeconds
      : Number(groupAvgIntervalSeconds)
  return Number.isFinite(avg) ? avg * groupSampleCount : 0
}

function toEntitySeriesPointsV5(
  byBucket: Map<number, BucketEntityAccumulatorV5>,
  fields: readonly string[],
  resolutionSeconds: number
): { points: EntitySeriesPointV5[]; sampleCount: number } {
  const points: EntitySeriesPointV5[] = []
  let sampleCount = 0
  const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0])
  for (const [bucketEpochSeconds, acc] of buckets) {
    sampleCount += acc.sampleCount
    const values: Partial<Record<string, number | null>> = {}
    for (const field of fields) {
      values[field] = finalizeFieldAccumulatorV5(acc.fields.get(field))
    }
    const avgIntervalSeconds =
      acc.sampleCount > 0 ? acc.intervalWeightedSum / acc.sampleCount : undefined
    points.push({
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values,
      sampleCount: acc.sampleCount,
      expectedSampleCount:
        avgIntervalSeconds !== undefined
          ? defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)
          : defaultExpectedSamplesPerBucket(resolutionSeconds),
    })
  }
  return { points, sampleCount }
}

// ---------------------------------------------------------------------------
// Single-row-per-entity families (managed.ingress / managed.database_proxy)
// ---------------------------------------------------------------------------

function buildSingleRowEntitySeriesSqlV5(
  input: EntitySeriesQueryV5,
  family: Extract<PerEntityHostedFamilyV5, 'managed.ingress' | 'managed.database_proxy'>,
  fields: readonly string[],
  entityIds: readonly string[],
  opts: { dataset: string; maxRangeSeconds: number }
): { sql: string; aliases: string[]; bucketSeconds: number } {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  const bucketSeconds = assertPositiveIntV5(
    'resolutionSeconds',
    input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS
  )
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const order = fieldOrderForFamilyV5(family)
  const aliases = fields.map((_, i) => metricAliasV5(i))
  const metricSelects = fields.map((field, i) => {
    const descriptor = resolveEntityFieldDescriptorV5(family, field)
    const fieldIndex = order.indexOf(field)
    return `${aggregateExpressionForDescriptorV5(descriptor, family, fieldIndex)} AS ${aliases[i]}`
  })
  const entityIdCol = blobColumnV5(AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX)
  const inList = entityIds.map((id) => quoteSqlStringV5(id)).join(', ')

  const sql = [
    'SELECT',
    `  intDiv(toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN}), ${bucketSeconds}) * ${bucketSeconds} AS bucket,`,
    `  ${entityIdCol} AS entity_id,`,
    `  SUM(_sample_interval) AS sample_count,`,
    `  SUM(${intervalSecondsColumnV5()} * _sample_interval) / SUM(_sample_interval) AS avg_interval_seconds,`,
    `  ${metricSelects.join(',\n  ')}`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${familyPredicateV5(family)}`,
    `  AND ${entityIdCol} IN (${inList})`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `GROUP BY bucket, entity_id`,
    `ORDER BY bucket ASC`,
  ].join('\n')

  return { sql, aliases, bucketSeconds }
}

/**
 * `GROUP BY bucket, entity_id` in {@link buildSingleRowEntitySeriesSqlV5}
 * guarantees AE returns at most one row per `(bucket, entityId)` pair, and
 * each metric select already resolves the FINAL aggregated value via
 * `aggregateExpressionForDescriptorV5` — so unlike the paged path, there is
 * no cross-row recombination to do here, just a direct row-to-point mapping.
 */
function parseSingleRowEntitySeriesRowsV5(
  fields: readonly string[],
  aliases: readonly string[],
  entityIds: readonly string[],
  data: Array<Record<string, unknown>>,
  resolutionSeconds: number
): EntitySeriesEntityResultV5[] {
  const perEntity = new Map<string, EntitySeriesPointV5[]>()
  for (const id of entityIds) perEntity.set(id, [])

  for (const row of data) {
    const entityId = typeof row.entity_id === 'string' ? row.entity_id : null
    if (entityId === null || !perEntity.has(entityId)) continue
    const bucketEpochSeconds = parseBucketEpochSecondsV5(row.bucket)
    if (!Number.isFinite(bucketEpochSeconds)) continue
    const sampleCountRaw = Number(row.sample_count ?? 0)
    const sampleCount = Number.isFinite(sampleCountRaw) ? sampleCountRaw : 0
    const avgIntervalSecondsRaw = Number(row.avg_interval_seconds)
    const expectedSampleCount = Number.isFinite(avgIntervalSecondsRaw)
      ? defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSecondsRaw)
      : defaultExpectedSamplesPerBucket(resolutionSeconds)

    const values: Partial<Record<string, number | null>> = {}
    fields.forEach((field, i) => {
      const raw = row[aliases[i]]
      if (raw === null || raw === undefined) {
        values[field] = null
        return
      }
      const num = typeof raw === 'number' ? raw : Number(raw)
      values[field] = Number.isFinite(num) ? stripAeV5Sentinel(num) : null
    })

    perEntity.get(entityId)!.push({
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values,
      sampleCount,
      expectedSampleCount,
    })
  }

  return entityIds.map((entityId) => {
    const points = perEntity.get(entityId)!.sort((a, b) => a.at.localeCompare(b.at))
    const sampleCount = points.reduce((sum, point) => sum + (point.sampleCount ?? 0), 0)
    return { entityId, points, sampleCount, gapCount: 0 }
  })
}

// ---------------------------------------------------------------------------
// Paged families (gpu/network/filesystem/block/hardware.physical)
// ---------------------------------------------------------------------------

type PagedFieldPlanV5 =
  | {
      field: string
      slot: number
      aggregation: 'weighted-average'
      numAlias: string
      denAlias: string
    }
  | { field: string; slot: number; aggregation: 'delta-sum'; rawAlias: string }
  | { field: string; slot: number; aggregation: 'max'; rawAlias: string }
  | {
      field: string
      slot: number
      aggregation: 'last'
      valueAlias: string
      keyAlias: string
    }

function buildPagedEntitySeriesSqlV5(
  input: EntitySeriesQueryV5,
  family: Exclude<PerEntityHostedFamilyV5, 'managed.ingress' | 'managed.database_proxy'>,
  fields: readonly string[],
  entityIds: readonly string[],
  opts: { dataset: string; maxRangeSeconds: number }
): { sql: string; plans: PagedFieldPlanV5[]; bucketSeconds: number } {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  const bucketSeconds = assertPositiveIntV5(
    'resolutionSeconds',
    input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS
  )
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const order = fieldOrderForFamilyV5(family)
  const width = order.length
  const perPage = entitiesPerPage(width)
  const sentinel = aeV5MissingMetricSentinelSql()
  const tsExpr = `toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN})`

  const plans: PagedFieldPlanV5[] = []
  const selects: string[] = []
  for (let slot = 0; slot < perPage; slot++) {
    for (const field of fields) {
      const descriptor = resolveEntityFieldDescriptorV5(family, field)
      const fieldIndex = order.indexOf(field)
      const doubleIndex = slotDoubleIndex(width, slot, fieldIndex)
      const col = doubleColumnV5(doubleIndex)
      const prefix = `f${fieldIndex}_s${slot}`

      switch (descriptor.aggregation) {
        case 'weighted-average': {
          const numAlias = `${prefix}_n`
          const denAlias = `${prefix}_d`
          selects.push(
            `SUM(if(${col} = ${sentinel}, 0.0, ${col} * ${intervalSecondsColumnV5()} * _sample_interval)) AS ${numAlias}`,
            `SUM(if(${col} = ${sentinel}, 0.0, ${intervalSecondsColumnV5()} * _sample_interval)) AS ${denAlias}`
          )
          plans.push({
            field,
            slot,
            aggregation: 'weighted-average',
            numAlias,
            denAlias,
          })
          break
        }
        case 'delta-sum': {
          const rawAlias = `${prefix}_r`
          selects.push(
            `SUM(if(${col} = ${sentinel}, 0.0, ${col} * _sample_interval)) AS ${rawAlias}`
          )
          plans.push({ field, slot, aggregation: 'delta-sum', rawAlias })
          break
        }
        case 'max': {
          const rawAlias = `${prefix}_r`
          selects.push(`MAX(${col}) AS ${rawAlias}`)
          plans.push({ field, slot, aggregation: 'max', rawAlias })
          break
        }
        case 'last': {
          const valueAlias = `${prefix}_v`
          const keyAlias = `${prefix}_k`
          const keyExpr = `if(${col} = ${sentinel}, ${tsExpr} * 0, ${tsExpr})`
          selects.push(
            `argMax(if(${col} = ${sentinel}, ${sentinel}, ${col}), ${keyExpr}) AS ${valueAlias}`,
            `MAX(${keyExpr}) AS ${keyAlias}`
          )
          plans.push({
            field,
            slot,
            aggregation: 'last',
            valueAlias,
            keyAlias,
          })
          break
        }
      }
    }
  }

  const idsCol = blobColumnV5(AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX)
  const entityPredicate = entityIds.map((id) => entityIdInPageIdentityPredicateV5(id)).join(' OR ')

  const sql = [
    'SELECT',
    `  intDiv(toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN}), ${bucketSeconds}) * ${bucketSeconds} AS bucket,`,
    `  ${idsCol} AS ids,`,
    `  SUM(_sample_interval) AS sample_count,`,
    `  SUM(${intervalSecondsColumnV5()} * _sample_interval) / SUM(_sample_interval) AS avg_interval_seconds,`,
    `  ${selects.join(',\n  ')}`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${familyPredicateV5(family)}`,
    `  AND (${entityPredicate})`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `GROUP BY bucket, ids`,
    `ORDER BY bucket ASC`,
  ].join('\n')

  return { sql, plans, bucketSeconds }
}

/** Split a page's blob10 identity list, returning each entity id's 0-based slot position. */
function splitPageIdentityV5(ids: string): string[] {
  return ids.length === 0 ? [] : ids.split(',')
}

function finiteNumberOrV5(raw: unknown, fallback: number): number {
  const num = Number(raw)
  return Number.isFinite(num) ? num : fallback
}

function applyPagedFieldPlanV5(
  acc: BucketEntityAccumulatorV5,
  plan: PagedFieldPlanV5,
  row: Record<string, unknown>
): void {
  const existing = acc.fields.get(plan.field)
  switch (plan.aggregation) {
    case 'weighted-average':
      acc.fields.set(
        plan.field,
        mergeFieldAccumulatorV5(existing, 'weighted-average', {
          numerator: finiteNumberOrV5(row[plan.numAlias], 0),
          denominator: finiteNumberOrV5(row[plan.denAlias], 0),
        })
      )
      return
    case 'delta-sum':
      acc.fields.set(
        plan.field,
        mergeFieldAccumulatorV5(existing, 'delta-sum', {
          raw: finiteNumberOrV5(row[plan.rawAlias], 0),
        })
      )
      return
    case 'max':
      acc.fields.set(
        plan.field,
        mergeFieldAccumulatorV5(existing, 'max', {
          raw: finiteNumberOrV5(row[plan.rawAlias], aeV5MissingSentinelValue()),
        })
      )
      return
    case 'last':
      acc.fields.set(
        plan.field,
        mergeFieldAccumulatorV5(existing, 'last', {
          value: finiteNumberOrV5(row[plan.valueAlias], aeV5MissingSentinelValue()),
          key: finiteNumberOrV5(row[plan.keyAlias], 0),
        })
      )
  }
}

function accumulatePagedEntitySlotV5(
  perEntity: Map<string, Map<number, BucketEntityAccumulatorV5>>,
  entityId: string,
  bucketEpochSeconds: number,
  groupSampleCount: number,
  row: Record<string, unknown>,
  plans: readonly PagedFieldPlanV5[],
  slot: number
): void {
  const byBucket = perEntity.get(entityId)
  if (byBucket === undefined) return
  const acc = byBucket.get(bucketEpochSeconds) ?? {
    sampleCount: 0,
    intervalWeightedSum: 0,
    fields: new Map(),
  }
  acc.sampleCount += groupSampleCount
  acc.intervalWeightedSum += mergeIntervalWeightedSumV5(row.avg_interval_seconds, groupSampleCount)
  for (const plan of plans) {
    if (plan.slot !== slot) continue
    applyPagedFieldPlanV5(acc, plan, row)
  }
  byBucket.set(bucketEpochSeconds, acc)
}

function parsePagedEntitySeriesRowsV5(
  fields: readonly string[],
  plans: readonly PagedFieldPlanV5[],
  entityIds: readonly string[],
  data: Array<Record<string, unknown>>,
  bucketSeconds: number
): EntitySeriesEntityResultV5[] {
  const perEntity = new Map<string, Map<number, BucketEntityAccumulatorV5>>()
  for (const id of entityIds) perEntity.set(id, new Map())

  for (const row of data) {
    const idsRaw = typeof row.ids === 'string' ? row.ids : ''
    const positions = splitPageIdentityV5(idsRaw)
    if (positions.length === 0) continue
    const bucketEpochSeconds = parseBucketEpochSecondsV5(row.bucket)
    if (!Number.isFinite(bucketEpochSeconds)) continue
    const groupSampleCount = finiteNumberOrV5(row.sample_count, 0)

    for (let slot = 0; slot < positions.length; slot++) {
      accumulatePagedEntitySlotV5(
        perEntity,
        positions[slot] ?? '',
        bucketEpochSeconds,
        groupSampleCount,
        row,
        plans,
        slot
      )
    }
  }

  return entityIds.map((entityId) => {
    const { points, sampleCount } = toEntitySeriesPointsV5(
      perEntity.get(entityId) ?? new Map(),
      fields,
      bucketSeconds
    )
    return { entityId, points, sampleCount, gapCount: 0 }
  })
}

// ---------------------------------------------------------------------------
// Embedded-NIC reconstruction (`network` family only) — see
// `types-v5.ts`'s `EntitySeriesQueryV5` doc comment and
// `field-map-v5.ts`'s `HOST_IO_EMBEDDED_NIC_FIELDS` for what's
// reconstructable and why. A slot-mapped NIC never pages as a standalone
// `network` row on this backend, so its series comes from `host.io`'s own
// rows instead of the paged-family machinery above.
// ---------------------------------------------------------------------------

/**
 * `slotMapping.normalNicSlots[0]`/`[1]` -> 0/1 (the two `host.io`-embedded
 * slots — see `field-map-v5.ts`'s `HOST_IO_EMBEDDED_NIC_SLOT_COUNT`),
 * restricted to ids actually present in `entityIds`. Slots 3+ are paged
 * `network` rows and resolve via the paged path like any other entity.
 */
function embeddedNicSlotForEntityIdV5(
  entityIds: readonly string[],
  slotMapping: SlotMapping | undefined
): Map<string, 0 | 1> {
  const bySlot = new Map<string, 0 | 1>()
  if (!slotMapping) return bySlot
  const requested = new Set(entityIds)
  const [slot1, slot2] = slotMapping.normalNicSlots
  if (slot1 && requested.has(slot1)) bySlot.set(slot1, 0)
  if (slot2 && requested.has(slot2)) bySlot.set(slot2, 1)
  return bySlot
}

function embeddedNicAliasV5(slot: 0 | 1, field: string): string {
  return `nic${slot}_${field}`
}

/**
 * Builds the shared `host.io` reconstruction query for both embedded NIC
 * slots at once (one row set carries both slots' columns per bucket — see
 * `field-map-v5.ts`'s `packHostIoDoubles`). Returns `null` when
 * `input.topologyGeneration` is unresolved: `host.io` rows carry no per-row
 * NIC identity, so without a generation to scope by, reconstruction cannot
 * safely tell today's slot assignment apart from an older one (see
 * `EntitySeriesQueryV5`'s doc comment) — callers report empty-but-present
 * results for embedded entities in that case rather than querying.
 */
function buildEmbeddedNicEntitySeriesSqlV5(
  input: EntitySeriesQueryV5,
  fields: readonly string[],
  opts: { dataset: string; maxRangeSeconds: number }
): { sql: string; bucketSeconds: number; embeddableFields: string[] } | null {
  if (input.topologyGeneration == null) return null

  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  const bucketSeconds = assertPositiveIntV5(
    'resolutionSeconds',
    input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS
  )
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const hostIoPred = familyPredicateV5(AE_V5_FAMILY_HOST_IO)
  const generationCol = blobColumnV5(AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX)
  const generationPred = `${generationCol} = ${quoteSqlStringV5(String(input.topologyGeneration))}`

  const embeddableFields = fields.filter((field) =>
    (HOST_IO_EMBEDDED_NIC_FIELDS as readonly string[]).includes(field)
  )
  const selects: string[] = []
  for (const slot of [0, 1] as const) {
    for (const field of embeddableFields) {
      const doubleIndex = hostIoEmbeddedNicDoubleIndex(
        slot,
        field as (typeof HOST_IO_EMBEDDED_NIC_FIELDS)[number]
      )
      selects.push(
        `${weightedAvgExpressionForColumnV5(
          AE_V5_FAMILY_HOST_IO,
          doubleIndex
        )} AS ${embeddedNicAliasV5(slot, field)}`
      )
    }
  }

  const sql = [
    'SELECT',
    `  intDiv(toUnixTimestamp(${AE_V5_TIMESTAMP_COLUMN}), ${bucketSeconds}) * ${bucketSeconds} AS bucket,`,
    `  SUM(if(${hostIoPred}, _sample_interval, 0.0)) AS sample_count,`,
    `  SUM(if(${hostIoPred}, ${intervalSecondsColumnV5()} * _sample_interval, 0.0)) / SUM(if(${hostIoPred}, _sample_interval, 0.0)) AS avg_interval_seconds` +
      (selects.length > 0 ? `,\n  ${selects.join(',\n  ')}` : ''),
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${hostIoPred}`,
    `  AND ${generationPred}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
    `GROUP BY bucket`,
    `ORDER BY bucket ASC`,
  ].join('\n')

  return { sql, bucketSeconds, embeddableFields }
}

function expectedSamplesFromAvgV5(resolutionSeconds: number, avgIntervalSeconds: number): number {
  if (!Number.isFinite(avgIntervalSeconds)) {
    return defaultExpectedSamplesPerBucket(resolutionSeconds)
  }
  return defaultExpectedSamplesPerBucket(resolutionSeconds, avgIntervalSeconds)
}

function embeddedNicFieldValueV5(
  field: string,
  embeddableFields: readonly string[],
  row: Record<string, unknown>,
  slot: 0 | 1
): number | null {
  if (!embeddableFields.includes(field)) return null
  const raw = row[embeddedNicAliasV5(slot, field)]
  const num = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(num) ? stripAeV5Sentinel(num) : null
}

/**
 * Parses one embedded NIC slot's points out of the shared query result (see
 * {@link buildEmbeddedNicEntitySeriesSqlV5}) — every requested field not in
 * `embeddableFields` (the 4 error/drop rates, never individually embedded)
 * resolves to `null`, never a fabricated split of the combined
 * problem-packets rate `host.io` actually carries.
 */
function parseEmbeddedNicEntitySeriesRowsV5(
  fields: readonly string[],
  embeddableFields: readonly string[],
  data: Array<Record<string, unknown>>,
  slot: 0 | 1,
  resolutionSeconds: number
): { points: EntitySeriesPointV5[]; sampleCount: number } {
  const points: EntitySeriesPointV5[] = []
  let sampleCount = 0
  for (const row of data) {
    const bucketEpochSeconds = parseBucketEpochSecondsV5(row.bucket)
    if (!Number.isFinite(bucketEpochSeconds)) continue
    const sampleCountRaw = Number(row.sample_count ?? 0)
    if (!Number.isFinite(sampleCountRaw)) continue
    if (sampleCountRaw <= 0) continue
    sampleCount += sampleCountRaw

    const values: Partial<Record<string, number | null>> = {}
    for (const field of fields) {
      values[field] = embeddedNicFieldValueV5(field, embeddableFields, row, slot)
    }

    points.push({
      at: new Date(bucketEpochSeconds * 1000).toISOString(),
      values,
      sampleCount: sampleCountRaw,
      expectedSampleCount: expectedSamplesFromAvgV5(
        resolutionSeconds,
        Number(row.avg_interval_seconds)
      ),
    })
  }
  return { points, sampleCount }
}

function withGapCountsV5(
  entities: EntitySeriesEntityResultV5[],
  from: string,
  to: string,
  resolutionSeconds: number
): EntitySeriesEntityResultV5[] {
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return entities
  return entities.map((entity) => ({
    ...entity,
    gapCount: computeSeriesGapCount({
      fromMs,
      toMs,
      resolutionSeconds,
      points: entity.points,
    }),
  }))
}

export async function queryEntitySeriesViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: EntitySeriesQueryV5
): Promise<EntitySeriesResultV5> {
  const fields = assertEntityFieldsV5(input.family, input.metrics)
  const entityIds = assertEntityIdsV5(input.entityIds)
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const client = new CloudflareAnalyticsSqlClient(config)

  let entities: EntitySeriesEntityResultV5[]
  let bucketSeconds: number

  if (input.family === 'network') {
    const embeddedSlotForId = embeddedNicSlotForEntityIdV5(entityIds, input.slotMapping)
    const pagedIds = entityIds.filter((id) => !embeddedSlotForId.has(id))
    const embeddedIds = entityIds.filter((id) => embeddedSlotForId.has(id))

    const pagedPromise =
      pagedIds.length > 0
        ? (async () => {
            const built = buildPagedEntitySeriesSqlV5(input, 'network', fields, pagedIds, {
              dataset,
              maxRangeSeconds,
            })
            const result = await client.executeSql(built.sql)
            return {
              bucketSeconds: built.bucketSeconds,
              entities: parsePagedEntitySeriesRowsV5(
                fields,
                built.plans,
                pagedIds,
                result.data,
                built.bucketSeconds
              ),
            }
          })()
        : null

    const embeddedPromise =
      embeddedIds.length > 0
        ? (async () => {
            const built = buildEmbeddedNicEntitySeriesSqlV5(input, fields, {
              dataset,
              maxRangeSeconds,
            })
            if (!built) {
              // No resolved topology generation — see
              // buildEmbeddedNicEntitySeriesSqlV5's doc comment. Still validate
              // the query shape so a malformed request fails the same way it
              // would on any other path.
              assertSafeServerId(input.serverId)
              const from = assertIsoTimestamp('from', input.from)
              const to = assertIsoTimestamp('to', input.to)
              assertRange(from, to, maxRangeSeconds)
              const fallbackBucketSeconds = assertPositiveIntV5(
                'resolutionSeconds',
                input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS
              )
              return {
                bucketSeconds: fallbackBucketSeconds,
                entities: embeddedIds.map((entityId) => ({
                  entityId,
                  points: [],
                  sampleCount: 0,
                  gapCount: 0,
                })),
              }
            }
            const result = await client.executeSql(built.sql)
            return {
              bucketSeconds: built.bucketSeconds,
              entities: embeddedIds.map((entityId) => {
                const slot = embeddedSlotForId.get(entityId)!
                const { points, sampleCount } = parseEmbeddedNicEntitySeriesRowsV5(
                  fields,
                  built.embeddableFields,
                  result.data,
                  slot,
                  built.bucketSeconds
                )
                return { entityId, points, sampleCount, gapCount: 0 }
              }),
            }
          })()
        : null

    const [pagedResult, embeddedResult] = await Promise.all([pagedPromise, embeddedPromise])

    bucketSeconds =
      pagedResult?.bucketSeconds ??
      embeddedResult?.bucketSeconds ??
      assertPositiveIntV5('resolutionSeconds', input.resolutionSeconds ?? AE_DEFAULT_BUCKET_SECONDS)

    const byEntityId = new Map<string, EntitySeriesEntityResultV5>()
    for (const entity of pagedResult?.entities ?? []) {
      byEntityId.set(entity.entityId, entity)
    }
    for (const entity of embeddedResult?.entities ?? []) {
      byEntityId.set(entity.entityId, entity)
    }
    entities = entityIds.map((id) => byEntityId.get(id)!)
  } else if (SINGLE_ROW_FAMILIES_V5.has(input.family)) {
    const family = input.family as Extract<
      PerEntityHostedFamilyV5,
      'managed.ingress' | 'managed.database_proxy'
    >
    const built = buildSingleRowEntitySeriesSqlV5(input, family, fields, entityIds, {
      dataset,
      maxRangeSeconds,
    })
    bucketSeconds = built.bucketSeconds
    const result = await client.executeSql(built.sql)
    entities = parseSingleRowEntitySeriesRowsV5(
      fields,
      built.aliases,
      entityIds,
      result.data,
      bucketSeconds
    )
  } else {
    const family = input.family as Exclude<
      PerEntityHostedFamilyV5,
      'managed.ingress' | 'managed.database_proxy'
    >
    const built = buildPagedEntitySeriesSqlV5(input, family, fields, entityIds, {
      dataset,
      maxRangeSeconds,
    })
    bucketSeconds = built.bucketSeconds
    const result = await client.executeSql(built.sql)
    entities = parsePagedEntitySeriesRowsV5(
      fields,
      built.plans,
      entityIds,
      result.data,
      bucketSeconds
    )
  }

  return {
    kind: 'analytics-engine',
    available: true,
    serverId: input.serverId,
    family: input.family,
    metrics: fields,
    resolutionSeconds: bucketSeconds,
    entities: withGapCountsV5(entities, input.from, input.to, bucketSeconds),
  }
}

// ---------------------------------------------------------------------------
// Entity ids seen — distinct entity ids of a family observed in a range.
// ---------------------------------------------------------------------------

function buildEntityIdsSeenSqlV5(
  input: EntityIdsSeenQueryV5,
  opts: { dataset: string; maxRangeSeconds: number }
): string {
  const serverId = assertSafeServerId(input.serverId)
  const from = assertIsoTimestamp('from', input.from)
  const to = assertIsoTimestamp('to', input.to)
  assertRange(from, to, opts.maxRangeSeconds)
  assertSafeDatasetNameV5(opts.dataset)

  const fromUnix = Math.floor(from.getTime() / 1000)
  const toUnix = Math.floor(to.getTime() / 1000)
  const discriminators = hostMetricsV5DiscriminatorPredicates()
  const idsCol = blobColumnV5(AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX)

  return [
    'SELECT',
    `  ${idsCol} AS ids`,
    `FROM ${opts.dataset}`,
    `WHERE ${serverIdPredicateV5(serverId)}`,
    `  AND ${discriminators[0]}`,
    `  AND ${discriminators[1]}`,
    `  AND ${familyPredicateV5(input.family)}`,
    `  AND ${timeRangePredicateV5(fromUnix, toUnix)}`,
  ].join('\n')
}

/**
 * For paged families, `ids` is a comma-joined list (every id in the page,
 * not a single entity) — so unlike the single-row families, distinctness has
 * to be computed in TypeScript across every row's split list rather than via
 * SQL `SELECT DISTINCT`.
 */
function parseEntityIdsSeenRowsV5(
  family: PerEntityHostedFamilyV5,
  data: Array<Record<string, unknown>>
): string[] {
  const seen = new Set<string>()
  const paged = !SINGLE_ROW_FAMILIES_V5.has(family)
  for (const row of data) {
    const raw = typeof row.ids === 'string' ? row.ids : ''
    if (!raw) continue
    if (paged) {
      for (const id of splitPageIdentityV5(raw)) seen.add(id)
    } else {
      seen.add(raw)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export async function queryEntityIdsSeenViaSqlApiV5(
  config: CloudflareAnalyticsSqlConfig,
  input: EntityIdsSeenQueryV5
): Promise<EntityIdsSeenResultV5> {
  const dataset = config.dataset ?? AE_V5_DATASET_NAME
  const maxRangeSeconds = config.maxRangeSeconds ?? AE_DEFAULT_MAX_RANGE_SECONDS
  const sql = buildEntityIdsSeenSqlV5(input, { dataset, maxRangeSeconds })
  const client = new CloudflareAnalyticsSqlClient(config)
  const result = await client.executeSql(sql)
  return {
    kind: 'analytics-engine',
    available: true,
    entityIds: parseEntityIdsSeenRowsV5(input.family, result.data),
  }
}
