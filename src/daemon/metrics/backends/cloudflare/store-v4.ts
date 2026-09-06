/**
 * Workers Analytics Engine metrics store (Cloudflare backend) for the v4
 * contract. Each sample is written as one `writeDataPoint` call per row
 * produced by {@link buildMetricsDataPointsV4} — see `field-map-v4.ts` for
 * the family emission order and presence-gating rules. Status transitions
 * stay one data point.
 *
 * `queryStatusHistory` is the one query method this store implements —
 * status rows have no per-entity/topology ambiguity (see `types-v4.ts`'s
 * `ServerMetricsStoreV4` doc comment), unlike the paged metric families,
 * whose entity-scoped query wiring is still a later phase (see
 * `sql-api-v4.ts`'s doc comment).
 */

import type {
  AuthenticatedMetricsSampleV4,
  EntityIdsSeenQueryV4,
  EntityIdsSeenResultV4,
  EntitySeriesQueryV4,
  EntitySeriesResultV4,
  FleetHostSnapshotQueryV4,
  FleetHostSnapshotResultV4,
  HostSeriesQueryV4,
  HostSeriesResultV4,
  HostSummaryQueryV4,
  HostSummaryResultV4,
  MetricEventsQueryV4,
  MetricEventsResultV4,
  ServerMetricsStoreV4,
  ServerStatusEvent,
  SlotMapping,
  StatusHistoryQuery,
  StatusHistoryResult,
} from '../../types-v4.ts'
import { buildMetricsDataPointsV4, buildStatusDataPointV4 } from './field-map-v4.ts'
import type { CloudflareAnalyticsSqlConfig } from './sql-api-v4.ts'
import {
  queryEntityIdsSeenViaSqlApiV4,
  queryEntitySeriesViaSqlApiV4,
  queryFleetHostSnapshotViaSqlApiV4,
  queryHostSeriesViaSqlApiV4,
  queryHostSummaryViaSqlApiV4,
  queryMetricEventsViaSqlApiV4,
  queryStatusHistoryViaSqlApiV4,
} from './sql-api-v4.ts'

/**
 * Narrow AE binding shape mirroring Workers `AnalyticsEngineDataset` /
 * `AnalyticsEngineDataPoint` (`indexes`, `doubles`, `blobs`).
 * Declared here (not imported from `worker-configuration.d.ts`) so the module
 * stays Deno-test portable; cast at `store-selection` / `workers.ts`.
 */
export type AnalyticsEngineDatasetLike = {
  writeDataPoint(event: { indexes?: string[]; doubles?: number[]; blobs?: string[] }): void
}

export type CloudflareAnalyticsEngineStoreOptionsV4 = {
  /** Optional SQL API config for queryStatusHistory. */
  sql?: CloudflareAnalyticsSqlConfig
}

/**
 * Workers Analytics Engine v4 metrics store.
 * Writes are fire-and-forget (`writeDataPoint` is sync / non-blocking).
 */
export class CloudflareAnalyticsEngineServerMetricsStoreV4 implements ServerMetricsStoreV4 {
  readonly #dataset: AnalyticsEngineDatasetLike
  readonly #sql: CloudflareAnalyticsSqlConfig | null

  constructor(
    dataset: AnalyticsEngineDatasetLike,
    options?: CloudflareAnalyticsEngineStoreOptionsV4
  ) {
    this.#dataset = dataset
    this.#sql = options?.sql ?? null
  }

  /**
   * One `writeDataPoint` call per row {@link buildMetricsDataPointsV4}
   * produces for this sample, all synchronous, fire-and-forget, never
   * awaited. Cloudflare docs: do not await; the runtime writes in the
   * background. `slotMapping` is forwarded verbatim — see that function's
   * doc comment for identity-addressed-vs-positional packing.
   */
  writeSample(input: AuthenticatedMetricsSampleV4, slotMapping?: SlotMapping): void {
    for (const point of buildMetricsDataPointsV4(input, slotMapping)) {
      this.#dataset.writeDataPoint(point)
    }
  }

  /**
   * Exactly one `writeDataPoint` for a connection-status transition —
   * synchronous, fire-and-forget (same discipline as {@link writeSample}).
   */
  writeStatusEvent(input: ServerStatusEvent): void {
    this.#dataset.writeDataPoint(buildStatusDataPointV4(input))
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
    return queryStatusHistoryViaSqlApiV4(this.#sql, input)
  }

  queryHostSeries(input: HostSeriesQueryV4): Promise<HostSeriesResultV4> {
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
    return queryHostSeriesViaSqlApiV4(this.#sql, input)
  }

  queryHostSummary(input: HostSummaryQueryV4): Promise<HostSummaryResultV4> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        sampleCount: 0,
        latestAt: null,
      })
    }
    return queryHostSummaryViaSqlApiV4(this.#sql, input)
  }

  queryFleetHostSnapshot(input: FleetHostSnapshotQueryV4): Promise<FleetHostSnapshotResultV4> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        metrics: input.metrics,
        servers: [],
      })
    }
    return queryFleetHostSnapshotViaSqlApiV4(this.#sql, input)
  }

  queryMetricEvents(input: MetricEventsQueryV4): Promise<MetricEventsResultV4> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        serverId: input.serverId,
        events: [],
        truncated: false,
      })
    }
    return queryMetricEventsViaSqlApiV4(this.#sql, input)
  }

  queryEntitySeries(input: EntitySeriesQueryV4): Promise<EntitySeriesResultV4> {
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
    return queryEntitySeriesViaSqlApiV4(this.#sql, input)
  }

  queryEntityIdsSeen(input: EntityIdsSeenQueryV4): Promise<EntityIdsSeenResultV4> {
    if (!this.#sql) {
      return Promise.resolve({
        kind: 'analytics-engine',
        available: false,
        entityIds: [],
      })
    }
    return queryEntityIdsSeenViaSqlApiV4(this.#sql, input)
  }
}
