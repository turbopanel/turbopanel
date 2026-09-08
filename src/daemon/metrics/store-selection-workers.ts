/**
 * Workers-only metrics store selection — no DuckDB / native-addon imports.
 * Workers entrypoints and Vitest pool suites must import from here, not
 * `store-selection.ts`, so workerd never loads `@duckdb/node-api`.
 */
import { CloudflareAnalyticsEngineServerMetricsStore } from './backends/cloudflare/store.ts'
import { DisabledServerMetricsStore } from './disabled-store.ts'
import type { ServerMetricsStore } from './types.ts'
import {
  type ResolveServerMetricsStoreInput,
  warnMetricsStoreSelectionOnce,
} from './store-selection-core.ts'

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
} from './store-selection-core.ts'

/**
 * Select the metrics store for Cloudflare Workers (Analytics Engine),
 * scoped to the current dataset/binding (`SERVER_METRICS`) — see
 * `backends/cloudflare/store.ts`. Deno callers must use
 * `resolveServerMetricsStore` from `store-selection.ts`.
 */
export function resolveServerMetricsStore(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStore {
  if (input.runtime !== 'workers') {
    throw new TypeError('Workers metrics store selection requires runtime: workers')
  }
  if (input.analyticsEngine) {
    return new CloudflareAnalyticsEngineServerMetricsStore(input.analyticsEngine, {
      sql: input.analyticsEngineSql ?? undefined,
    })
  }
  warnMetricsStoreSelectionOnce(
    'workers-missing-ae',
    'server metrics on Workers but SERVER_METRICS binding missing; using disabled store'
  )
  return new DisabledServerMetricsStore()
}
