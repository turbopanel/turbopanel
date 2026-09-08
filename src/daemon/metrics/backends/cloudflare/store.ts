/**
 * Workers Analytics Engine metrics store (Cloudflare backend) for the v5
 * contract. Each sample is written as one `writeDataPoint` call per row
 * produced by {@link buildMetricsDataPoints} — see `field-map.ts` for
 * the family emission order and presence-gating rules. Status transitions
 * stay one data point.
 *
 * `queryStatusHistory` is the one query method this store implements —
 * status rows have no per-entity/topology ambiguity (see `types.ts`'s
 * `ServerMetricsStore` doc comment), unlike the paged metric families,
 * whose entity-scoped query wiring is still a later phase (see
 * `sql-api.ts`'s doc comment).
 */

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
  SlotMapping,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../types.ts'
import { buildMetricsDataPoints, buildStatusDataPoint } from './field-map.ts'
import type { CloudflareAnalyticsSqlConfig } from './sql-api.ts'
import {
  queryEntityIdsSeenViaSqlApi,
  queryEntitySeriesViaSqlApi,
  queryFleetHostSnapshotViaSqlApi,
  queryHostSeriesViaSqlApi,
  queryHostSummaryViaSqlApi,
  queryMetricEventsViaSqlApi,
  queryStatusHistoryViaSqlApi,
} from './sql-api.ts'

/**
 * Narrow AE binding shape mirroring Workers `AnalyticsEngineDataset` /
 * `AnalyticsEngineDataPoint` (`indexes`, `doubles`, `blobs`).
 * Declared here (not imported from `worker-configuration.d.ts`) so the module
 * stays Deno-test portable; cast at `store-selection` / `workers.ts`.
 */
export type AnalyticsEngineDatasetLike = {
  writeDataPoint(event: { indexes?: string[]; doubles?: number[]; blobs?: string[] }): void
}

export type CloudflareAnalyticsEngineStoreOptions = {
  /** Optional SQL API config for queryStatusHistory. */
  sql?: CloudflareAnalyticsSqlConfig
}

/**
 * Workers Analytics Engine v5 metrics store.
 * Writes are fire-and-forget (`writeDataPoint` is sync / non-blocking).
 */
export class CloudflareAnalyticsEngineServerMetricsStore implements ServerMetricsStore {
  readonly #dataset: AnalyticsEngineDatasetLike
  readonly #sql: CloudflareAnalyticsSqlConfig | null

  constructor(
    dataset: AnalyticsEngineDatasetLike,
    options?: CloudflareAnalyticsEngineStoreOptions
  ) {
    this.#dataset = dataset
    this.#sql = options?.sql ?? null
  }

  /**
   * One `writeDataPoint` call per row {@link buildMetricsDataPoints}
   * produces for this sample, all synchronous, fire-and-forget, never
   * awaited. Cloudflare docs: do not await; the runtime writes in the
   * background. `slotMapping` is forwarded verbatim — see that function's
   * doc comment for identity-addressed-vs-positional packing.
   */
  writeSample(input: AuthenticatedMetricsSample, slotMapping?: SlotMapping): void {
    for (const point of buildMetricsDataPoints(input, slotMapping)) {
      this.#dataset.writeDataPoint(point)
    }
  }

  /**
   * Exactly one `writeDataPoint` for a connection-status transition —
   * synchronous, fire-and-forget (same discipline as {@link writeSample}).
   */
  writeStatusEvent(input: ServerStatusEvent): void {
    this.#dataset.writeDataPoint(buildStatusDataPoint(input))
  }

  queryStatusHistory(input: StatusHistoryQuery): Promise<StatusHistoryResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        initialConnected: null,
        events: [],
        uptimeSeconds: 0,
        downtimeSeconds: 0,
        unknownSeconds: 0,
        uptimePercent: null,
        truncated: false,
      })
    }
    return queryStatusHistoryViaSqlApi(this.#sql, input)
  }

  queryHostSeries(input: HostSeriesQuery): Promise<HostSeriesResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        metrics: input.metrics,
        points: [],
        resolutionSeconds: null,
        gapCount: 0,
        sampleCount: 0,
      })
    }
    return queryHostSeriesViaSqlApi(this.#sql, input)
  }

  queryHostSummary(input: HostSummaryQuery): Promise<HostSummaryResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        sampleCount: 0,
        latestAt: null,
      })
    }
    return queryHostSummaryViaSqlApi(this.#sql, input)
  }

  queryFleetHostSnapshot(input: FleetHostSnapshotQuery): Promise<FleetHostSnapshotResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        metrics: input.metrics,
        servers: [],
      })
    }
    return queryFleetHostSnapshotViaSqlApi(this.#sql, input)
  }

  queryMetricEvents(input: MetricEventsQuery): Promise<MetricEventsResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        events: [],
        truncated: false,
      })
    }
    return queryMetricEventsViaSqlApi(this.#sql, input)
  }

  queryEntitySeries(input: EntitySeriesQuery): Promise<EntitySeriesResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        family: input.family,
        metrics: input.metrics,
        resolutionSeconds: null,
        entities: [],
      })
    }
    return queryEntitySeriesViaSqlApi(this.#sql, input)
  }

  queryEntityIdsSeen(input: EntityIdsSeenQuery): Promise<EntityIdsSeenResult> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        entityIds: [],
      })
    }
    return queryEntityIdsSeenViaSqlApi(this.#sql, input)
  }
}
