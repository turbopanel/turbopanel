import type { AnalyticsEngineDatasetLike } from './backends/cloudflare/store.ts'
import {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  type CloudflareAnalyticsSqlConfig,
} from './backends/cloudflare/sql-api.ts'
import type {
  AuthenticatedMetricsSample,
  EntityIdsSeenQuery,
  EntityIdsSeenResult,
  EntitySeriesQuery,
  EntitySeriesResult,
  FleetHostSnapshotQuery,
  FleetHostSnapshotResult,
  HostSeriesQuery,
  HostSeriesResult,
  HostSummaryQuery,
  HostSummaryResult,
  MetricEventsQuery,
  MetricEventsResult,
  ServerMetricsStore,
  ServerStatusEvent,
  StatusHistoryQuery,
  StatusHistoryResult,
} from './types.ts'

export type { AnalyticsEngineDatasetLike, CloudflareAnalyticsSqlConfig }
export { AE_DEFAULT_MAX_RANGE_SECONDS }

const warnedKeys = new Set<string>()

export function warnMetricsStoreSelectionOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return
  warnedKeys.add(key)
  console.warn(message)
}

/** Test seam: clear warn-once keys. */
export function resetMetricsStoreSelectionWarningsForTests(): void {
  warnedKeys.clear()
}

export type MetricsEnvValue = string | number | undefined | null

function parsePositiveIntegerEnvValue(value: MetricsEnvValue): number | undefined {
  if (value === undefined || value === null) return undefined
  const normalized = String(value).trim()
  if (!normalized) return undefined
  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined
  return parsed
}

/**
 * Parse optional AE max-range override (positive integer seconds).
 * Invalid / empty values fall through to the retention-aligned default.
 */
export const parseAnalyticsEngineMaxRangeSeconds = parsePositiveIntegerEnvValue

/**
 * Resolve AE SQL API credentials from Workers env.
 * Returns null when account id or token is missing (writes still work).
 * Always sets `maxRangeSeconds` (env override or documented AE retention default)
 * so hosted query APIs can enforce retention without re-patching the store.
 */
export function resolveCloudflareAnalyticsSqlConfig(env: {
  CLOUDFLARE_ACCOUNT_ID?: string
  TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN?: string
  TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS?: string | number
}): CloudflareAnalyticsSqlConfig | null {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.TURBOPANEL_ANALYTICS_ENGINE_API_TOKEN?.trim()
  if (!accountId || !apiToken) return null
  const maxRangeSeconds =
    parseAnalyticsEngineMaxRangeSeconds(env.TURBOPANEL_SERVER_METRICS_AE_MAX_RANGE_SECONDS) ??
    AE_DEFAULT_MAX_RANGE_SECONDS
  return { accountId, apiToken, maxRangeSeconds }
}

/**
 * Parse optional metrics retention days (positive integer).
 * Invalid / empty values fall through to the schema default (90).
 */
export const parseMetricsRetentionDays = parsePositiveIntegerEnvValue

/**
 * Parse an optional positive-integer env value (DuckDB threads / memory cap).
 * Invalid / empty values fall through to the DuckDB defaults.
 */
export const parsePositiveIntEnv = parsePositiveIntegerEnvValue

/**
 * Store for an attempted backend that failed to open — a real outage, not an
 * unconfigured deployment. Reads reject so the HTTP routes surface
 * `metrics_backend_unavailable` (503) through their existing failure path,
 * instead of the disabled store's silent `available: false`. Writes stay
 * fire-and-forget no-ops — there is nowhere to persist them and callers must
 * never be blocked by the broken backend.
 */
export class UnavailableServerMetricsStore implements ServerMetricsStore {
  readonly reason: string

  constructor(reason: string) {
    this.reason = reason
  }

  writeSample(_input: AuthenticatedMetricsSample): void {
    // no-op: backend is down; metrics writes are fire-and-forget by contract.
  }

  writeStatusEvent(_input: ServerStatusEvent): void {
    // no-op: backend is down; status writes are fire-and-forget by contract.
  }

  queryStatusHistory(_input: StatusHistoryQuery): Promise<StatusHistoryResult> {
    return Promise.reject(new Error(this.reason))
  }

  queryHostSeries(_input: HostSeriesQuery): Promise<HostSeriesResult> {
    return Promise.reject(new Error(this.reason))
  }

  queryHostSummary(_input: HostSummaryQuery): Promise<HostSummaryResult> {
    return Promise.reject(new Error(this.reason))
  }

  queryEntitySeries(_input: EntitySeriesQuery): Promise<EntitySeriesResult> {
    return Promise.reject(new Error(this.reason))
  }

  queryEntityIdsSeen(_input: EntityIdsSeenQuery): Promise<EntityIdsSeenResult> {
    return Promise.reject(new Error(this.reason))
  }

  queryFleetHostSnapshot(_input: FleetHostSnapshotQuery): Promise<FleetHostSnapshotResult> {
    return Promise.reject(new Error(this.reason))
  }

  queryMetricEvents(_input: MetricEventsQuery): Promise<MetricEventsResult> {
    return Promise.reject(new Error(this.reason))
  }
}

export type ResolveServerMetricsStoreInput = {
  runtime: 'workers' | 'deno'
  analyticsEngine?: AnalyticsEngineDatasetLike
  /** AE SQL API credentials (Workers query path). */
  analyticsEngineSql?: CloudflareAnalyticsSqlConfig | null
  duckdb?: {
    /** Metrics state root override (default: `resolveMetricsDir()`). */
    metricsDir?: string
    threads?: number
    memoryLimitMb?: number
    retentionDays?: number
  }
}
