import { DuckDbParquetServerMetricsStore } from './backends/duckdb/store.ts'
import type { ServerMetricsStore } from './types.ts'
import {
  type ResolveServerMetricsStoreInput,
  UnavailableServerMetricsStore,
  warnMetricsStoreSelectionOnce,
} from './store-selection-core.ts'
import { resolveServerMetricsStore as resolveWorkersServerMetricsStore } from './store-selection-workers.ts'

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
  UnavailableServerMetricsStore,
} from './store-selection-core.ts'

/**
 * Select Deno's v5 metrics store. `DuckDbParquetServerMetricsStore` is the
 * single Deno store instance (`backends/duckdb/store.ts`) — a construction
 * failure degrades to `UnavailableServerMetricsStore` (reads reject with
 * `metrics_backend_unavailable`, writes stay silent no-ops), never to the
 * disabled store, since a DuckDB startup failure is a self-hosted backend
 * outage, not an "unconfigured" state.
 */
function resolveDenoServerMetricsStore(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStore {
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
    return new UnavailableServerMetricsStore(`DuckDB metrics store failed to open: ${message}`)
  }
}

/**
 * Select the v5 host metrics store for the current runtime.
 * Server metrics are always on — there is no enable/disable gate.
 * Workers → Analytics Engine; Deno → DuckDB.
 * Only a genuinely unconfigured backend (Workers without the AE binding)
 * falls back to the disabled no-op store; an attempted backend that fails
 * to open resolves to a store whose reads reject, so metrics routes return
 * 503 `metrics_backend_unavailable` instead of hiding the outage.
 */
export function resolveServerMetricsStore(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStore {
  if (input.runtime === 'workers') {
    return resolveWorkersServerMetricsStore(input)
  }
  return resolveDenoServerMetricsStore(input)
}
