import { DuckDbParquetServerMetricsStore } from './backends/duckdb/store.ts'
import type { ServerMetricsStoreV4 } from './types-v4.ts'
import {
  type ResolveServerMetricsStoreInput,
  UnavailableServerMetricsStoreV4,
  warnMetricsStoreSelectionOnce,
} from './store-selection-core.ts'
import { resolveServerMetricsStoreV4 as resolveWorkersServerMetricsStoreV4 } from './store-selection-workers.ts'

export type {
  AnalyticsEngineDatasetLike,
  CloudflareAnalyticsSqlConfig,
  MetricsEnvValue,
  ResolveServerMetricsStoreInput,
} from './store-selection-core.ts'
export {
  AE_DEFAULT_MAX_RANGE_SECONDS,
  parseAnalyticsEngineMaxRangeSeconds,
  parseMetricsRetentionDays,
  parsePositiveIntEnv,
  resetMetricsStoreSelectionWarningsForTests,
  resolveCloudflareAnalyticsSqlConfig,
  UnavailableServerMetricsStoreV4,
} from './store-selection-core.ts'

/**
 * Select Deno's v4 metrics store. `DuckDbParquetServerMetricsStore` is the
 * single Deno store instance (`backends/duckdb/store.ts`) — a construction
 * failure degrades to `UnavailableServerMetricsStoreV4` (reads reject with
 * `metrics_backend_unavailable`, writes stay silent no-ops), never to the
 * disabled store, since a DuckDB startup failure is a self-hosted backend
 * outage, not an "unconfigured" state.
 */
function resolveDenoServerMetricsStoreV4(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStoreV4 {
  // Deno → DuckDB, always: the metrics directory derives from
  // `resolveMetricsDir()` with a filesystem default, so there is no
  // "incomplete config" case — only a directory that cannot be created.
  try {
    return new DuckDbParquetServerMetricsStore(input.duckdb ?? {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnMetricsStoreSelectionOnce(
      'deno-missing-duckdb',
      `server metrics on Deno but DuckDB store failed to open; metrics reads will return 503 (${message})`
    )
    return new UnavailableServerMetricsStoreV4(`DuckDB metrics store failed to open: ${message}`)
  }
}

/**
 * Select the v4 host metrics store for the current runtime.
 * Server metrics are always on — there is no enable/disable gate.
 * Workers → Analytics Engine; Deno → DuckDB.
 * Only a genuinely unconfigured backend (Workers without the AE binding)
 * falls back to the disabled no-op store; an attempted backend that fails
 * to open resolves to a store whose reads reject, so metrics routes return
 * 503 `metrics_backend_unavailable` instead of hiding the outage.
 */
export function resolveServerMetricsStoreV4(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStoreV4 {
  if (input.runtime === 'workers') {
    return resolveWorkersServerMetricsStoreV4(input)
  }
  return resolveDenoServerMetricsStoreV4(input)
}
