/**
 * Workers-only metrics store selection — no DuckDB / native-addon imports.
 * Workers entrypoints and Vitest pool suites must import from here, not
 * `store-selection.ts`, so workerd never loads `@duckdb/node-api`.
 */
import { CloudflareAnalyticsEngineServerMetricsStoreV4 } from './backends/cloudflare/store-v4.ts'
import { DisabledServerMetricsStoreV4 } from './disabled-store-v4.ts'
import type { ServerMetricsStoreV4 } from './types-v4.ts'
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
 * Select the v4 metrics store for Cloudflare Workers (Analytics Engine),
 * scoped to the v4 dataset/binding (`SERVER_METRICS_V4`) — see
 * `backends/cloudflare/store-v4.ts`. Deno callers must use
 * `resolveServerMetricsStoreV4` from `store-selection.ts`.
 */
export function resolveServerMetricsStoreV4(
  input: ResolveServerMetricsStoreInput
): ServerMetricsStoreV4 {
  if (input.runtime !== 'workers') {
    throw new TypeError('Workers metrics store selection requires runtime: workers')
  }
  if (input.analyticsEngine) {
    return new CloudflareAnalyticsEngineServerMetricsStoreV4(input.analyticsEngine, {
      sql: input.analyticsEngineSql ?? undefined,
    })
  }
  warnMetricsStoreSelectionOnce(
    'workers-missing-ae-v4',
    'server metrics v4 on Workers but SERVER_METRICS_V4 binding missing; using disabled store'
  )
  return new DisabledServerMetricsStoreV4()
}
