import type { MetricEventV5, MetricsSampleV5 } from './contract-v5.ts'
import type { HostedFamilyV5 } from './metric-descriptors-v5.ts'
import type { SlotMapping } from '../../client/servers/topology-types.ts'

export type { SlotMapping } from '../../client/servers/topology-types.ts'

/** Live cadence granted to a lease holder, in seconds. */
export const METRICS_LIVE_INTERVAL_SECONDS = 10

/** Success body of `POST /servers/:id/metrics/live` (start/renew a lease). */
export type MetricsLiveLeaseStartResponse = {
  ok: true
  leaseId: string
  intervalSeconds: typeof METRICS_LIVE_INTERVAL_SECONDS
  expiresAt: string
}

// Backend-neutral by design where these shared types are concerned: no
// physical storage tokens (doubleN/blobN/indexN column names,
// AnalyticsEngineDataPoint, DuckDB DDL) may appear here — those live in
// per-backend field-map/schema files.
export type MetricsBackendKind = 'disabled' | 'analytics-engine' | 'duckdb'

/** Why a `connected` boolean flipped — closed enum for status-stream rows. */
export type ServerStatusTransitionReason = 'connect' | 'disconnect' | 'sweep_stale' | 'self_heal'

/** Validated connection-status transition written to AE / DuckDB. */
export type ServerStatusEvent = {
  serverId: string
  connected: boolean
  reason: ServerStatusTransitionReason
  at: string
}

export type StatusHistoryQuery = {
  serverId: string
  from: string
  to: string
}

export type StatusHistoryEvent = {
  at: string
  connected: boolean
  reason: ServerStatusTransitionReason
}

/**
 * Connection history + uptime totals for a range.
 *
 * `initialConnected === null` means state before `from` is unknown — that span
 * accrues to `unknownSeconds`, never to uptime or downtime.
 */
export type StatusHistoryResult = {
  kind: MetricsBackendKind
  available: boolean
  serverId: string
  initialConnected: boolean | null
  events: StatusHistoryEvent[]
  uptimeSeconds: number
  downtimeSeconds: number
  unknownSeconds: number
  uptimePercent: number | null
  truncated: boolean
}

/** Authenticated v5 sample after validation — `serverId` always from auth context, never wire input. */
export type AuthenticatedMetricsSampleV5 = MetricsSampleV5 & {
  serverId: string
  receivedAt: string
}

/**
 * Per-entity metric families that can be queried by entity id via
 * `queryEntitySeries` / `queryEntityIdsSeen` — every {@link HostedFamilyV5}
 * except the host-singleton `host.system` / `host.io` (those go through
 * `queryHostSeries` / `queryHostSummary` instead, since a server has exactly
 * one of each, never many).
 *
 * `managed.ingress` / `managed.database_proxy` are included even though they
 * physically write one unpaged row per entity rather than a shared page
 * (`field-map-v5.ts`'s `packSingleEntityRow`) — they still have multiple
 * entity instances per server, so they still need entity-scoped querying.
 * For these two families, the "entity id" is `sourceId` — distinct source
 * instances stay distinct entities even when they share a `sourceKind` — see
 * `EntitySeriesQueryV5.entityIds` doc comment.
 */
export type PerEntityHostedFamilyV5 = Extract<
  HostedFamilyV5,
  | 'gpu'
  | 'network'
  | 'filesystem'
  | 'block'
  | 'hardware.physical'
  | 'managed.ingress'
  | 'managed.database_proxy'
>

// ---------------------------------------------------------------------------
// Host series / summary — host.system + host.io singleton metrics.
// ---------------------------------------------------------------------------

/**
 * Multi-metric host series query. `metrics` are canonical names from
 * `HOST_METRICS_METRIC_DESCRIPTORS_V5` scoped to a `host.*` entity scope
 * (`host.cpu.busyPercent`, `host.memory.availableBytes`, etc.) — see
 * `entity-metric-id.ts` for the host-singleton identity format, which is
 * exactly the canonical name.
 */
export type HostSeriesQueryV5 = {
  serverId: string
  metrics: readonly string[]
  from: string
  to: string
  resolutionSeconds?: number
}

/**
 * One bucket timestamp with a values map keyed by requested canonical name.
 * `topologyGeneration` replaces v3's `hardwareProfileGeneration` — `null`
 * means unknown or the bucket spans a topology reassignment (mixed
 * generations), a boundary marker for series-continuity breaks. Omitted
 * when the backend doesn't track generations.
 */
export type HostSeriesPointV5 = {
  at: string
  values: Partial<Record<string, number | null>>
  /** Underlying samples contributing to this bucket. */
  sampleCount?: number
  /** Expected samples for full bucket coverage (gap detection). */
  expectedSampleCount?: number
  topologyGeneration?: number | null
}

export type HostSeriesResultV5 = {
  kind: MetricsBackendKind
  available: boolean
  serverId: string
  /** Echo of the metrics requested. */
  metrics: readonly string[]
  points: HostSeriesPointV5[]
  resolutionSeconds: number | null
  /** Number of missing buckets in the resolved resolution grid. */
  gapCount: number
  /** Number of underlying samples contributing to the series. */
  sampleCount: number
  /**
   * Distinct topology generations observed anywhere in the queried range,
   * sorted ascending — `length > 1` means the server's topology changed
   * during the window. Omitted when the backend doesn't track generations.
   */
  topologyGenerations?: number[]
}

export type HostSummaryQueryV5 = {
  serverId: string
  from: string
  to: string
}

export type HostSummaryResultV5 = {
  kind: MetricsBackendKind
  available: boolean
  serverId: string
  sampleCount: number
  /** Latest sample timestamp in range, if any. */
  latestAt: string | null
}

// ---------------------------------------------------------------------------
// Entity series — per-entity families (gpu/network/filesystem/block/
// hardware.physical/managed.ingress/managed.database_proxy).
// ---------------------------------------------------------------------------

/**
 * Multi-entity, multi-metric series query for one {@link PerEntityHostedFamilyV5}.
 *
 * `entityIds` identifies which entity instances to return, within `family`:
 *  - `gpu` -> `gpuId`, `network` -> `deviceId`, `filesystem` -> `filesystemId`,
 *    `block` -> `deviceId`, `hardware.physical` -> `signalId`: the contract
 *    entity id, matching `entity-metric-id.ts`'s per-entity identity.
 *  - `managed.ingress` / `managed.database_proxy` -> `sourceId`, **not**
 *    `sourceKind`. Cloudflare Analytics Engine writes `sourceId` to blob10 for
 *    these two families (`field-map-v5.ts`'s `AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX`
 *    doc comment) — `sourceKind` never reaches AE at all. DuckDB stores both
 *    columns but groups by `source_id` here too so the two backends agree on
 *    what an "entity id" means for these families — two different sources of
 *    the same `sourceKind` (e.g. two Caddy instances) remain distinct
 *    entities. Use `queryEntityIdsSeen` to discover which `sourceId` values
 *    actually appear in a range rather than assuming a fixed set.
 *
 * `metrics` are bare field names (`HostMetricsMetricDescriptorV5.fieldName`)
 * scoped to `family`'s entity scope — not canonical names, since canonical
 * names for these scopes never carry an entity id anyway.
 *
 * Note on embedded NICs: a host's first one or two normal-NIC-slot network
 * devices are embedded directly into `host.io` (see `field-map-v5.ts`'s
 * `resolveNetworkSlots`) and never page as standalone `network` rows on the
 * Cloudflare backend. DuckDB, by contrast, writes every reported network
 * device to its per-family table regardless of slot embedding.
 *
 * A `network`-family query for one of these slot-mapped NICs is still
 * answerable on both backends: DuckDB already has the full row, and the
 * Cloudflare backend reconstructs `receiveBytesPerSecond`/
 * `transmitBytesPerSecond` (the only two individually-addressable embedded
 * fields — see `field-map-v5.ts`'s `HOST_IO_EMBEDDED_NIC_FIELDS`) from
 * `host.io`'s own rows when `slotMapping` identifies the entity as one of
 * the first two `normalNicSlots`. Any other requested `network` field
 * resolves to `null` for those two entities on Cloudflare, never a
 * fabricated split of the combined problem-packets rate `host.io` actually
 * carries. A device in `slotMapping.fabricDeviceIds` has no reconstruction
 * path at all (never embedded, never paged) and stays genuinely unanswerable
 * on Cloudflare — callers must still reject those before querying (see
 * `metrics-routes-helpers.ts`'s `findFabricNetworkEntityId`).
 */
export type EntitySeriesQueryV5 = {
  serverId: string
  family: PerEntityHostedFamilyV5
  entityIds: readonly string[]
  metrics: readonly string[]
  from: string
  to: string
  resolutionSeconds?: number
  /**
   * Current topology's `SlotMapping`, consulted only for `family: "network"`
   * — identifies which of `entityIds` (if any) are the first two
   * `normalNicSlots` so the Cloudflare backend can reconstruct their series
   * from `host.io` instead of the (nonexistent) paged `network` rows. `undefined`
   * on a backend/caller that doesn't resolve one (e.g. no recorded topology
   * generation yet) — every requested entity is then treated as independently
   * paged, matching pre-slot-mapping behavior.
   */
  slotMapping?: SlotMapping
  /**
   * The topology generation `slotMapping` was computed for. `host.io` rows
   * carry no per-row NIC identity (unlike a paged `network` row's blob10), so
   * the embedded-NIC reconstruction scopes its `host.io` scan to this exact
   * generation — otherwise a slot reassignment (an operator changing
   * `nicSlotDeviceIds`) would relabel older `host.io`
   * history as the new device. `null`/`undefined` (no recorded generation)
   * means the reconstruction finds no in-range rows rather than guessing.
   */
  topologyGeneration?: number | null
}

export type EntitySeriesPointV5 = {
  at: string
  values: Partial<Record<string, number | null>>
  sampleCount?: number
  /** Expected samples for full bucket coverage (gap detection) — see `HostSeriesPointV5.expectedSampleCount`. */
  expectedSampleCount?: number
}

export type EntitySeriesEntityResultV5 = {
  entityId: string
  points: EntitySeriesPointV5[]
  sampleCount: number
  gapCount: number
}

export type EntitySeriesResultV5 = {
  kind: MetricsBackendKind
  available: boolean
  serverId: string
  family: PerEntityHostedFamilyV5
  metrics: readonly string[]
  resolutionSeconds: number | null
  entities: EntitySeriesEntityResultV5[]
}

/** Discover which entity ids of `family` were actually observed in a range — see `EntitySeriesQueryV5` doc comment for what "id" means per family. */
export type EntityIdsSeenQueryV5 = {
  serverId: string
  family: PerEntityHostedFamilyV5
  from: string
  to: string
}

export type EntityIdsSeenResultV5 = {
  kind: MetricsBackendKind
  available: boolean
  entityIds: string[]
}

// ---------------------------------------------------------------------------
// Fleet host snapshot — one query across many servers, host metrics only.
// ---------------------------------------------------------------------------

/**
 * One AE/DuckDB query for recent host usage across many servers.
 * Used by the org servers overview — never N per-server chart calls.
 */
export type FleetHostSnapshotQueryV5 = {
  serverIds: readonly string[]
  metrics: readonly string[]
  from: string
  to: string
}

export type FleetHostSnapshotServerV5 = {
  serverId: string
  latestAt: string | null
  values: Partial<Record<string, number | null>>
  sampleCount: number
  /**
   * Topology generation shared by every contributing sample in the queried
   * window, or `null` when unknown or mixed (a reassignment happened inside
   * the window). Omitted when the backend doesn't track generations.
   */
  topologyGeneration?: number | null
}

export type FleetHostSnapshotResultV5 = {
  kind: MetricsBackendKind
  available: boolean
  metrics: readonly string[]
  servers: FleetHostSnapshotServerV5[]
}

// ---------------------------------------------------------------------------
// Metric events (`sample.events` — hardware-health / lifecycle notices).
// ---------------------------------------------------------------------------

export type MetricEventsQueryV5 = {
  serverId: string
  from: string
  to: string
}

export type MetricEventsResultV5 = {
  kind: MetricsBackendKind
  available: boolean
  serverId: string
  events: MetricEventV5[]
  /** `true` when more events exist in range than the backend's cap returned — same discipline as `StatusHistoryResult.truncated`. */
  truncated: boolean
}

/**
 * Backend-neutral write sink for v5 host metrics samples and connection
 * status events, plus (where a real query-capable backend implements it)
 * the v5 read surface: host series/summary, per-entity series, entity-id
 * discovery, fleet host snapshot, metric events, and connection-status
 * history.
 *
 * Every query method is optional-on-interface (mirroring how
 * `queryStatusHistory` was optional before this phase) so
 * `DisabledServerMetricsStoreV5` needs no changes, and
 * `UnavailableServerMetricsStoreV5` (`store-selection-core.ts`) can add
 * rejection stubs incrementally.
 *
 * `writeSample` / `writeStatusEvent` are fire-and-forget — callers must not
 * await them into WS / request handlers (same discipline as v3 writes).
 *
 * `writeSample`'s optional `slotMapping` is the caller-resolved
 * `(topology generation) -> SlotMapping` result (see
 * `client/servers/topology-slot-mapping.ts`) for the sample's own
 * `metadata.topologyGeneration` — resolving it requires a DB read, so it is
 * computed by the ingest route (which already does that work for capability
 * planning), never by the store itself. `undefined` means the generation
 * hasn't been recorded yet; implementations must fall back to a
 * topology-agnostic packing in that case (see `field-map-v5.ts`).
 */
export interface ServerMetricsStoreV5 {
  writeSample(input: AuthenticatedMetricsSampleV5, slotMapping?: SlotMapping): void | Promise<void>
  writeStatusEvent(input: ServerStatusEvent): void | Promise<void>
  queryStatusHistory?(input: StatusHistoryQuery): Promise<StatusHistoryResult>
  queryHostSeries?(input: HostSeriesQueryV5): Promise<HostSeriesResultV5>
  queryHostSummary?(input: HostSummaryQueryV5): Promise<HostSummaryResultV5>
  queryEntitySeries?(input: EntitySeriesQueryV5): Promise<EntitySeriesResultV5>
  queryEntityIdsSeen?(input: EntityIdsSeenQueryV5): Promise<EntityIdsSeenResultV5>
  queryFleetHostSnapshot?(input: FleetHostSnapshotQueryV5): Promise<FleetHostSnapshotResultV5>
  queryMetricEvents?(input: MetricEventsQueryV5): Promise<MetricEventsResultV5>
}
