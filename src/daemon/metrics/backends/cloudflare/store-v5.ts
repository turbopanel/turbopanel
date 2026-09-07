/**
 * Workers Analytics Engine metrics store (Cloudflare backend) for the v5
 * contract. Each sample is written as one `writeDataPoint` call per row
 * produced by {@link buildMetricsDataPointsV5} — see `field-map-v5.ts` for
 * the family emission order and presence-gating rules. Status transitions
 * stay one data point.
 *
 * `queryStatusHistory` is the one query method this store implements —
 * status rows have no per-entity/topology ambiguity (see `types-v5.ts`'s
 * `ServerMetricsStoreV5` doc comment), unlike the paged metric families,
 * whose entity-scoped query wiring is still a later phase (see
 * `sql-api-v5.ts`'s doc comment).
 */

import type {
  AuthenticatedMetricsSampleV5,
  EntityIdsSeenQueryV5,
  EntityIdsSeenResultV5,
  EntitySeriesQueryV5,
  EntitySeriesResultV5,
  FleetHostSnapshotQueryV5,
  FleetHostSnapshotResultV5,
  HostSeriesQueryV5,
  HostSeriesResultV5,
  HostSummaryQueryV5,
  HostSummaryResultV5,
  MetricEventsQueryV5,
  MetricEventsResultV5,
  ServerMetricsStoreV5,
  ServerStatusEvent,
  SlotMapping,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../types-v5.ts'
import { buildMetricsDataPointsV5, buildStatusDataPointV5 } from './field-map-v5.ts'
import type { CloudflareAnalyticsSqlConfig } from './sql-api-v5.ts'
import {
  queryEntityIdsSeenViaSqlApiV5,
  queryEntitySeriesViaSqlApiV5,
  queryFleetHostSnapshotViaSqlApiV5,
  queryHostSeriesViaSqlApiV5,
  queryHostSummaryViaSqlApiV5,
  queryMetricEventsViaSqlApiV5,
  queryStatusHistoryViaSqlApiV5,
} from './sql-api-v5.ts'

/**
 * Narrow AE binding shape mirroring Workers `AnalyticsEngineDataset` /
 * `AnalyticsEngineDataPoint` (`indexes`, `doubles`, `blobs`).
 * Declared here (not imported from `worker-configuration.d.ts`) so the module
 * stays Deno-test portable; cast at `store-selection` / `workers.ts`.
 */
export type AnalyticsEngineDatasetLike = {
  writeDataPoint(event: { indexes?: string[]; doubles?: number[]; blobs?: string[] }): void
}

export type CloudflareAnalyticsEngineStoreOptionsV5 = {
  /** Optional SQL API config for queryStatusHistory. */
  sql?: CloudflareAnalyticsSqlConfig
}

/**
 * Workers Analytics Engine v5 metrics store.
 * Writes are fire-and-forget (`writeDataPoint` is sync / non-blocking).
 */
export class CloudflareAnalyticsEngineServerMetricsStoreV5 implements ServerMetricsStoreV5 {
  readonly #dataset: AnalyticsEngineDatasetLike
  readonly #sql: CloudflareAnalyticsSqlConfig | null

  constructor(
    dataset: AnalyticsEngineDatasetLike,
    options?: CloudflareAnalyticsEngineStoreOptionsV5
  ) {
    this.#dataset = dataset
    this.#sql = options?.sql ?? null
  }

  /**
   * One `writeDataPoint` call per row {@link buildMetricsDataPointsV5}
   * produces for this sample, all synchronous, fire-and-forget, never
   * awaited. Cloudflare docs: do not await; the runtime writes in the
   * background. `slotMapping` is forwarded verbatim — see that function's
   * doc comment for identity-addressed-vs-positional packing.
   */
  writeSample(input: AuthenticatedMetricsSampleV5, slotMapping?: SlotMapping): void {
    for (const point of buildMetricsDataPointsV5(input, slotMapping)) {
      this.#dataset.writeDataPoint(point)
    }
  }

  /**
   * Exactly one `writeDataPoint` for a connection-status transition —
   * synchronous, fire-and-forget (same discipline as {@link writeSample}).
   */
  writeStatusEvent(input: ServerStatusEvent): void {
    this.#dataset.writeDataPoint(buildStatusDataPointV5(input))
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
    return queryStatusHistoryViaSqlApiV5(this.#sql, input)
  }

  queryHostSeries(input: HostSeriesQueryV5): Promise<HostSeriesResultV5> {
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
    return queryHostSeriesViaSqlApiV5(this.#sql, input)
  }

  queryHostSummary(input: HostSummaryQueryV5): Promise<HostSummaryResultV5> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        sampleCount: 0,
        latestAt: null,
      })
    }
    return queryHostSummaryViaSqlApiV5(this.#sql, input)
  }

  queryFleetHostSnapshot(input: FleetHostSnapshotQueryV5): Promise<FleetHostSnapshotResultV5> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        metrics: input.metrics,
        servers: [],
      })
    }
    return queryFleetHostSnapshotViaSqlApiV5(this.#sql, input)
  }

  queryMetricEvents(input: MetricEventsQueryV5): Promise<MetricEventsResultV5> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        events: [],
        truncated: false,
      })
    }
    return queryMetricEventsViaSqlApiV5(this.#sql, input)
  }

  queryEntitySeries(input: EntitySeriesQueryV5): Promise<EntitySeriesResultV5> {
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
    return queryEntitySeriesViaSqlApiV5(this.#sql, input)
  }

  queryEntityIdsSeen(input: EntityIdsSeenQueryV5): Promise<EntityIdsSeenResultV5> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        entityIds: [],
      })
    }
    return queryEntityIdsSeenViaSqlApiV5(this.#sql, input)
  }
}
