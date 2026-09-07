/**
 * Workers-only metrics store selection — no DuckDB / native-addon imports.
 * Workers entrypoints and Vitest pool suites must import from here, not
 * `store-selection.ts`, so workerd never loads `@duckdb/node-api`.
 */
import { CloudflareAnalyticsEngineServerMetricsStoreV5 } from './backends/cloudflare/store-v5.ts'
import { DisabledServerMetricsStoreV5 } from './disabled-store-v5.ts'
import type { ServerMetricsStoreV5 } from './types-v5.ts'
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
 * Select the v5 metrics store for Cloudflare Workers (Analytics Engine),
 * scoped to the v5 dataset/binding (`SERVER_METRICS_V5`) — see
 * `backends/cloudflare/store-v5.ts`. Deno callers must use
 * `resolveServerMetricsStoreV5` from `store-selection.ts`.
 */
export function resolveServerMetricsStoreV5(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStoreV5 {
  if (input.runtime !== 'workers') {
    throw new TypeError('Workers metrics store selection requires runtime: workers')
  }
  if (input.analyticsEngine) {
    return new CloudflareAnalyticsEngineServerMetricsStoreV5(input.analyticsEngine, {
      sql: input.analyticsEngineSql ?? undefined,
    })
  }
  warnMetricsStoreSelectionOnce(
    'workers-missing-ae-v5',
    'server metrics v5 on Workers but SERVER_METRICS_V5 binding missing; using disabled store'
  )
  return new DisabledServerMetricsStoreV5()
}
