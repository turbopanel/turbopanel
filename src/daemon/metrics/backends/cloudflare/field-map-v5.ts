/**
 * Cloudflare Analytics Engine positional field map for the current metrics
 * contract — the single source of truth for the double1..double20 /
 * blob1..blob20 layout on the `turbopanel_server_metrics_v5` dataset.
 *
 * Metrics are grouped by entity/family (`metric-descriptors-v5.ts`'s
 * `hostedFamily`). This module is the packing layer for the active
 * Analytics Engine dataset.
 *
 * Slot assignment is identity-addressed when a `SlotMapping` is available
 * (`client/servers/topology-slot-mapping.ts`'s `computeSlotMapping`, resolved
 * by the ingest route from the sample's own `metadata.topologyGeneration` —
 * see {@link buildMetricsDataPointsV5}'s `slotMapping` parameter and
 * `types-v5.ts`'s `ServerMetricsStoreV5.writeSample` doc comment):
 *
 *  - `host.io`'s otherwise-unused double12..double17 embed the first two
 *    `slotMapping.normalNicSlots` entries (slot 1 / slot 2, looked up by
 *    `deviceId` in `sample.networks`) so the common 1-NIC/2-NIC host reports
 *    its primary NIC(s) without ever writing a `network` page. Devices in
 *    `slotMapping.fabricDeviceIds` never page as `network` rows either —
 *    a 2-NIC host with a TurboFabric mesh interface stays at 2 rows
 *    (`host.system` + `host.io`), never 3. Slots 3+ (a self-hosted or
 *    higher-tier operator monitoring more uplinks) page as `network` rows in
 *    slot order, followed by any genuinely-unaccounted-for device (neither a
 *    slot nor a known fabric device — normally already dropped at ingest by
 *    `capability-plan.ts`).
 *  - `gpu` / `network` / `filesystem` / `block` pages order their entities by
 *    `slotMapping`'s matching `*PageOrder` list (entities the mapping
 *    doesn't know about yet — new since the topology generation was
 *    recorded — are appended in their original sample order) and stamp
 *    blob10 with that page's entity ids, comma-joined in the same order as
 *    the page's double values (same idiom `hardware.physical` already used).
 *
 * `slotMapping` is optional: when the caller has no recorded topology
 * generation for this sample yet (first sample, resync pending), every
 * family above falls back to the pre-topology behavior this module always
 * had — positional packing (`networks[0]`/`networks[1]` embed, `networks`
 * beyond that page in arrival order, other families keep arrival order) —
 * so an unresolved generation degrades gracefully rather than silently
 * dropping data.
 *
 * External storage contract: never inline positional literals elsewhere;
 * always derive columns and write payloads through this module.
 */

import {
  type CpuDetailSampleV5,
  type MemoryDetailSampleV5,
  type MetricEventV5,
  METRICS_SCHEMA_VERSION_V5,
  type MetricsSampleV5,
  type NetworkDeviceSampleV5,
} from '../../contract-v5.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS_V5,
  type HostedFamilyV5,
  type HostMetricsMetricDescriptorV5,
  type MetricEntityScopeV5,
} from '../../metric-descriptors-v5.ts'
import type {
  AuthenticatedMetricsSampleV5,
  ServerStatusEvent,
  SlotMapping,
} from '../../types-v5.ts'

/** Analytics Engine dataset for the current metrics contract. */
export const AE_V5_DATASET_NAME = 'turbopanel_server_metrics_v5'

export const AE_V5_DOUBLE_COUNT = 20
export const AE_V5_BLOB_COUNT = 20

/**
 * Physical AE row budget for metric-value double slots (double1..double19) —
 * one reserved interval slot on double20.
 */
export const AE_V5_METRIC_DOUBLE_SLOT_COUNT = 19

/** double20 on every `"metrics"`-kind row — the sample's `intervalSeconds`. */
export const AE_V5_DOUBLE_INTERVAL_INDEX = 19

/** double1 on `"status"`-kind rows — connected (1) / disconnected (0). */
export const AE_V5_DOUBLE_STATUS_CONNECTED_INDEX = 0

/**
 * Missing-metric sentinel (AE doubles have no null; 0 would silently skew
 * averages; all host metrics are >= 0).
 */
export const AE_V5_MISSING_METRIC_SENTINEL = -1e308

// ---------------------------------------------------------------------------
// Envelope blob indexes (0-based — `blobColumnV5` maps to `blob<index+1>`).
// ---------------------------------------------------------------------------

/** blob1 — row-kind discriminator: `"metrics"` / `"event"` / `"status"`. */
export const AE_V5_BLOB_KIND_INDEX = 0
/**
 * blob2 — on `"metrics"` rows, the {@link HostedFamilyV5}; on `"event"` rows,
 * the event's `kind` (`MetricEventKindV5`); empty on `"status"` rows.
 */
export const AE_V5_BLOB_FAMILY_INDEX = 1
/** blob3 — schema version (stringified integer, every row kind). */
export const AE_V5_BLOB_SCHEMA_VERSION_INDEX = 2
/** blob4 — collection mode (`"baseline"` / `"live"`); empty on `"status"` rows. */
export const AE_V5_BLOB_COLLECTION_MODE_INDEX = 3
/**
 * blob5 — sample timestamp. On `"metrics"` rows, `metadata.sampledAt`; on
 * `"event"` rows, the event's own `at` (more precise than the enclosing
 * sample's timestamp); empty on `"status"` rows (AE stamps its own ingestion
 * timestamp there, matching v3).
 */
export const AE_V5_BLOB_SAMPLED_AT_INDEX = 4
/** blob6 — enclosing sample's sequence (stringified integer); empty on `"status"` rows. */
export const AE_V5_BLOB_SEQUENCE_INDEX = 5
/** blob7 — `metadata.topologyGeneration` (stringified integer); empty on `"status"` rows. */
export const AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX = 6
/**
 * blob8 — reserved for a capability-plan-generation hash. Always `""` for
 * now: no capability-plan-generation value is threaded through
 * `AuthenticatedMetricsSampleV5` yet. Future: stamp this once ingest carries
 * that generation alongside `topologyGeneration`.
 */
export const AE_V5_BLOB_CAPABILITY_PLAN_GENERATION_INDEX = 7
/** blob9 — page index within a paged per-entity family (`"0"` for unpaged rows). */
export const AE_V5_BLOB_PAGE_INDEX = 8
/**
 * blob10 — family-conditional: `sourceId` for `managed.ingress` /
 * `managed.database_proxy` rows, comma-joined per-page entity ids (in the
 * same order as that page's double values) for `gpu` / `network` /
 * `filesystem` / `block` / `hardware.physical` rows, `event.source` for
 * `"event"` rows, empty on `host.system` / `host.io`.
 */
export const AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX = 9
/** blob11 — `"event"` rows only: `event.entityId` (empty when absent). */
export const AE_V5_BLOB_EVENT_ENTITY_ID_INDEX = 10
/** blob12 — `"event"` rows only: `JSON.stringify(event.payload ?? {})`. */
export const AE_V5_BLOB_EVENT_PAYLOAD_INDEX = 11
/** blob13 — `"event"` rows only: `event.eventId`. Empty on every other row kind. */
export const AE_V5_BLOB_EVENT_ID_INDEX = 12
/** blob14..blob16 stay reserved-empty on every row kind. */
export const AE_V5_RESERVED_MID_BLOB_COUNT = 3
/**
 * blob17 — `"status"` rows: {@link ServerStatusEvent.reason}. `"event"` rows:
 * the event's `severity`. Empty on `"metrics"` rows.
 */
export const AE_V5_BLOB_STATUS_OR_EVENT_REASON_INDEX = 16
/** blob18..blob20 stay reserved-empty on every row kind. */
export const AE_V5_RESERVED_TRAILING_BLOB_COUNT = 3

/** blob1 discriminator values. */
export const AE_V5_KIND_METRICS = 'metrics'
export const AE_V5_KIND_EVENT = 'event'
export const AE_V5_KIND_STATUS = 'status'

/** blob2 discriminator values for `"metrics"` rows — mirrors {@link HostedFamilyV5} exactly. */
export const AE_V5_FAMILY_HOST_SYSTEM: HostedFamilyV5 = 'host.system'
export const AE_V5_FAMILY_HOST_IO: HostedFamilyV5 = 'host.io'
export const AE_V5_FAMILY_GPU: HostedFamilyV5 = 'gpu'
export const AE_V5_FAMILY_NETWORK: HostedFamilyV5 = 'network'
export const AE_V5_FAMILY_FILESYSTEM: HostedFamilyV5 = 'filesystem'
export const AE_V5_FAMILY_BLOCK: HostedFamilyV5 = 'block'
export const AE_V5_FAMILY_HARDWARE_PHYSICAL: HostedFamilyV5 = 'hardware.physical'
export const AE_V5_FAMILY_MANAGED_INGRESS: HostedFamilyV5 = 'managed.ingress'
export const AE_V5_FAMILY_MANAGED_DATABASE_PROXY: HostedFamilyV5 = 'managed.database_proxy'
export const AE_V5_FAMILY_CPU_DETAIL: HostedFamilyV5 = 'cpu.detail'
export const AE_V5_FAMILY_MEMORY_DETAIL: HostedFamilyV5 = 'memory.detail'

/**
 * Physical column name for the authenticated serverId identity slot
 * (`indexes[0]` on the write path, `index1` on the SQL read path).
 */
export const AE_V5_INDEX_SERVER_ID_COLUMN = 'index1'

/** Physical column name for the AE ingestion timestamp. */
export const AE_V5_TIMESTAMP_COLUMN = 'timestamp'

/** Narrow AE data-point shape mirroring Workers `AnalyticsEngineDataPoint`. */
export type AnalyticsEngineDataPointLikeV5 = {
  indexes: [string]
  doubles: number[]
  blobs: string[]
}

export function blobColumnV5(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_V5_BLOB_COUNT) {
    throw new TypeError(`invalid AE v5 blob index: ${index}`)
  }
  return `blob${index + 1}`
}

export function doubleColumnV5(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_V5_DOUBLE_COUNT) {
    throw new TypeError(`invalid AE v5 double index: ${index}`)
  }
  return `double${index + 1}`
}

/** AE column for the interval-seconds weight slot (`double20`). */
export function intervalSecondsColumnV5(): string {
  return doubleColumnV5(AE_V5_DOUBLE_INTERVAL_INDEX)
}

/** AE column for status-row connected (1/0). */
export function statusConnectedColumnV5(): string {
  return doubleColumnV5(AE_V5_DOUBLE_STATUS_CONNECTED_INDEX)
}

/** AE column for status-row transition reason / event-row severity. */
export function statusReasonColumnV5(): string {
  return blobColumnV5(AE_V5_BLOB_STATUS_OR_EVENT_REASON_INDEX)
}

/** Test-only: assert doubles/blobs lengths (used by shape-drift tests). */
export function assertAnalyticsEngineDataPointShapeV5(point: {
  doubles: number[]
  blobs: string[]
}): void {
  if (point.doubles.length !== AE_V5_DOUBLE_COUNT) {
    throw new TypeError(`AE v5 doubles length ${point.doubles.length} !== ${AE_V5_DOUBLE_COUNT}`)
  }
  if (point.blobs.length !== AE_V5_BLOB_COUNT) {
    throw new TypeError(`AE v5 blobs length ${point.blobs.length} !== ${AE_V5_BLOB_COUNT}`)
  }
}

// ---------------------------------------------------------------------------
// host.system / host.io — fixed-shape single-row families. Field order is a
// hand-declared, test-pinned array (not object insertion order), verified at
// module load against `HOST_METRICS_METRIC_DESCRIPTORS_V5` so it can never
// silently drift from the actual descriptor set.
// ---------------------------------------------------------------------------

const HOST_CPU_FIELD_ORDER = [
  'busyPercent',
  'userPercent',
  'systemPercent',
  'iowaitPercent',
  'stealPercent',
  'softirqPercent',
  'pressureSomePercent',
  'saturatedCoreCount',
  'procsRunning',
  'procsBlocked',
] as const

/**
 * Host fields whose entity scope is `host.cpu`/`host.memory` but which are
 * physically packed on the **host.io** AE row, because `host.system`'s 19
 * double slots are full. Order here is the physical slot order, starting
 * immediately after host.io's descriptor + NIC-embed slots.
 */
const HOST_IO_OVERFLOW_FIELD_ORDER: readonly HostFieldRef[] = [
  { scope: 'host.cpu', field: 'processCount' },
  { scope: 'host.memory', field: 'majorPageFaultsPerSecond' },
]

const HOST_KERNEL_FIELD_ORDER = ['fileHandlesUsedPercent', 'conntrackUsedPercent'] as const

const HOST_MEMORY_FIELD_ORDER = [
  'usedBytes',
  'cachedFilesBytes',
  'swapUsedBytes',
  'pressureSomePercent',
  'pressureFullPercent',
  'swapInBytesPerSecond',
  'swapOutBytesPerSecond',
] as const

const HOST_STORAGE_FIELD_ORDER = [
  'ioPressureSomePercent',
  'ioPressureFullPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'diskLatencyMs',
  'rootFilesystemAvailableBytes',
  'rootFilesystemFreeInodes',
] as const

const HOST_NETWORK_FIELD_ORDER = ['tcpRetransmitPercent', 'softnetDropsPerSecond'] as const

type HostFieldRef = { scope: MetricEntityScopeV5; field: string }

function hostFieldRefs(scope: MetricEntityScopeV5, fields: readonly string[]): HostFieldRef[] {
  return fields.map((field) => ({ scope, field }))
}

/** host.system's 19 double slots (double1..double19), in declared order. */
const HOST_SYSTEM_FIELD_ORDER: readonly HostFieldRef[] = [
  ...hostFieldRefs('host.cpu', HOST_CPU_FIELD_ORDER),
  ...hostFieldRefs('host.kernel', HOST_KERNEL_FIELD_ORDER),
  ...hostFieldRefs('host.memory', HOST_MEMORY_FIELD_ORDER),
]

/** host.io's 11 descriptor-owned double slots (double1..double11). */
const HOST_IO_FIELD_ORDER: readonly HostFieldRef[] = [
  ...hostFieldRefs('host.storage', HOST_STORAGE_FIELD_ORDER),
  ...hostFieldRefs('host.network', HOST_NETWORK_FIELD_ORDER),
]

/**
 * host.io's 6 NIC-embedded double slots (double12..double17): 3 values
 * (receive bytes/s, transmit bytes/s, combined problem-packets/s) for each of
 * the first two `networks[]` entries — see the module doc comment.
 */
const HOST_IO_NIC_EMBED_SLOT_COUNT = 6
/** First host.io double after descriptor + NIC-embed slots — where the overflow fields start (double18 today). */
const HOST_IO_OVERFLOW_BASE_DOUBLE_INDEX = HOST_IO_FIELD_ORDER.length + HOST_IO_NIC_EMBED_SLOT_COUNT

function hostFieldValue(sample: MetricsSampleV5, ref: HostFieldRef): number | null {
  const groupKey = ref.scope.slice('host.'.length) as keyof MetricsSampleV5['host']
  const group = sample.host[groupKey] as unknown as Record<string, number | null>
  return group[ref.field] ?? null
}

/** Sum of a NIC's four error/drop rates, or the sentinel if any input is missing. */
function combinedProblemPacketsPerSecond(nic: NetworkDeviceSampleV5 | undefined): number {
  if (!nic) return AE_V5_MISSING_METRIC_SENTINEL
  const parts = [
    nic.receiveErrorsPerSecond,
    nic.transmitErrorsPerSecond,
    nic.receiveDropsPerSecond,
    nic.transmitDropsPerSecond,
  ]
  if (parts.includes(null)) return AE_V5_MISSING_METRIC_SENTINEL
  return (parts as number[]).reduce((sum, value) => sum + value, 0)
}

function packHostSystemDoubles(sample: MetricsSampleV5): number[] {
  const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
  HOST_SYSTEM_FIELD_ORDER.forEach((ref, i) => {
    doubles[i] = hostFieldValue(sample, ref) ?? AE_V5_MISSING_METRIC_SENTINEL
  })
  doubles[AE_V5_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds
  return doubles
}

function packHostIoDoubles(
  sample: MetricsSampleV5,
  nic0: NetworkDeviceSampleV5 | undefined,
  nic1: NetworkDeviceSampleV5 | undefined
): number[] {
  const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
  HOST_IO_FIELD_ORDER.forEach((ref, i) => {
    doubles[i] = hostFieldValue(sample, ref) ?? AE_V5_MISSING_METRIC_SENTINEL
  })
  HOST_IO_OVERFLOW_FIELD_ORDER.forEach((ref, i) => {
    doubles[HOST_IO_OVERFLOW_BASE_DOUBLE_INDEX + i] =
      hostFieldValue(sample, ref) ?? AE_V5_MISSING_METRIC_SENTINEL
  })
  const embedBase = HOST_IO_FIELD_ORDER.length
  doubles[embedBase] = nic0?.receiveBytesPerSecond ?? AE_V5_MISSING_METRIC_SENTINEL
  doubles[embedBase + 1] = nic0?.transmitBytesPerSecond ?? AE_V5_MISSING_METRIC_SENTINEL
  doubles[embedBase + 2] = combinedProblemPacketsPerSecond(nic0)
  doubles[embedBase + 3] = nic1?.receiveBytesPerSecond ?? AE_V5_MISSING_METRIC_SENTINEL
  doubles[embedBase + 4] = nic1?.transmitBytesPerSecond ?? AE_V5_MISSING_METRIC_SENTINEL
  doubles[embedBase + 5] = combinedProblemPacketsPerSecond(nic1)
  doubles[AE_V5_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds
  return doubles
}

/** How many `normalNicSlots` entries `host.io` embeds — slots 1 and 2; every later slot pages. */
export const HOST_IO_EMBEDDED_NIC_SLOT_COUNT = 2

/**
 * Resolve which `networks[]` entries embed in `host.io` (slots 1/2) versus
 * page as standalone `network` rows, given an optional `SlotMapping`.
 *
 * With a mapping: slot 1/slot 2 are looked up by `deviceId` (never by array
 * position — a topology reorder must not silently reinterpret a slot), and
 * any device listed in `fabricDeviceIds` is excluded from paging entirely —
 * this is what keeps a 2-NIC-plus-fabric host at 2 rows instead of 3. Slots
 * 3+ page first, in slot order, then any device that is neither a slot nor a
 * known fabric device (arrival order).
 *
 * Without a mapping (generation not recorded yet): falls back to this
 * module's original positional behavior — `networks[0]`/`networks[1]` embed,
 * everything else pages — since there is no way yet to tell a fabric device
 * apart from an ordinary extra NIC.
 */
function resolveNetworkSlots(
  networks: readonly NetworkDeviceSampleV5[],
  slotMapping: SlotMapping | undefined
): {
  nic0: NetworkDeviceSampleV5 | undefined
  nic1: NetworkDeviceSampleV5 | undefined
  paged: NetworkDeviceSampleV5[]
} {
  if (!slotMapping) {
    return { nic0: networks[0], nic1: networks[1], paged: networks.slice(2) }
  }
  const byId = new Map(networks.map((device) => [device.deviceId, device]))
  const [slot1, slot2] = slotMapping.normalNicSlots
  const nic0 = slot1 ? byId.get(slot1) : undefined
  const nic1 = slot2 ? byId.get(slot2) : undefined
  const excluded = new Set<string>([
    ...slotMapping.fabricDeviceIds,
    ...slotMapping.normalNicSlots.slice(0, HOST_IO_EMBEDDED_NIC_SLOT_COUNT),
  ])
  const pagedSlots = slotMapping.normalNicSlots
    .slice(HOST_IO_EMBEDDED_NIC_SLOT_COUNT)
    .map((id) => byId.get(id))
    .filter((device): device is NetworkDeviceSampleV5 => device !== undefined)
  const pagedSlotIds = new Set(pagedSlots.map((device) => device.deviceId))
  const paged = [
    ...pagedSlots,
    ...networks.filter(
      (device) => !excluded.has(device.deviceId) && !pagedSlotIds.has(device.deviceId)
    ),
  ]
  return { nic0, nic1, paged }
}

/**
 * Reorder `entities` by `pageOrder` (a `SlotMapping.*PageOrder` list of
 * stable ids, sorted by id — see `topology-slot-mapping.ts`), looked up via
 * `idOf`. An entity present in the sample but not (yet) known to `pageOrder`
 * — new since the topology generation was recorded — is appended afterward
 * in its original sample order, so a device the daemon just started
 * reporting is never silently dropped while topology catches up. Without a
 * `pageOrder` (no slot mapping resolved), returns `entities` unchanged —
 * the module's original arrival-order packing.
 */
function orderByPageOrder<T>(
  entities: readonly T[],
  idOf: (entity: T) => string,
  pageOrder: readonly string[] | undefined
): T[] {
  if (!pageOrder) return [...entities]
  const byId = new Map(entities.map((entity) => [idOf(entity), entity] as const))
  const ordered: T[] = []
  for (const id of pageOrder) {
    const entity = byId.get(id)
    if (entity !== undefined) {
      ordered.push(entity)
      byId.delete(id)
    }
  }
  for (const entity of entities) {
    if (byId.has(idOf(entity))) ordered.push(entity)
  }
  return ordered
}

// ---------------------------------------------------------------------------
// Per-entity paged families (gpu, network, filesystem, block) and the
// hardware-physical signal family. Every entity's fields are laid out
// sequentially within its slot; a page's trailing unused slots (before
// double20) stay sentinel by construction (the doubles array starts
// sentinel-filled).
// ---------------------------------------------------------------------------

const GPU_FIELD_ORDER = [
  'utilizationPercent',
  'memoryUsedBytes',
  'memoryActivityPercent',
  'temperatureCelsius',
  'memoryTemperatureCelsius',
  'powerWatts',
  'pcieReceiveBytesPerSecond',
  'pcieTransmitBytesPerSecond',
  'throttlePercent',
] as const

const NETWORK_FIELD_ORDER = [
  'receiveBytesPerSecond',
  'transmitBytesPerSecond',
  'receiveErrorsPerSecond',
  'transmitErrorsPerSecond',
  'receiveDropsPerSecond',
  'transmitDropsPerSecond',
] as const

const FILESYSTEM_FIELD_ORDER = ['availableBytes', 'freeInodes'] as const

const BLOCK_FIELD_ORDER = [
  'readBytesPerSecond',
  'writeBytesPerSecond',
  'readOpsPerSecond',
  'writeOpsPerSecond',
  'readLatencyMs',
  'writeLatencyMs',
  'utilizationPercent',
  'temperatureCelsius',
  'queueDepth',
] as const

const HARDWARE_SIGNAL_FIELD_ORDER = ['value'] as const

const INGRESS_FIELD_ORDER = [
  'requests',
  'responses2xx',
  'responses3xx',
  'responses4xx',
  'responses5xx',
  'requestErrors',
  'requestBytes',
  'responseBytes',
  'requestDurationSecondsAvg',
  'requestsUnder100ms',
  'requestsUnder500ms',
  'requestsUnder1s',
  'requestsUnder5s',
  'requestsInFlight',
  'upstreamsHealthy',
  'upstreamsTotal',
  'retries',
] as const

const DATABASE_PROXY_FIELD_ORDER = [
  'queries',
  'slowQueries',
  'connectionErrors',
  'clientConnections',
  'backendConnections',
  'backendsUp',
] as const

/** `cpu.detail`'s slot budget: 7 host-wide scalars, double1..double7. */
export const CPU_DETAIL_SLOT_COUNT = 7

/** `cpu.detail`'s 7 host-wide scalar fields (double1..double7). v5 removed the 4 embedded busiest-core hotspots that used to precede them. */
const CPU_DETAIL_SCALAR_FIELD_ORDER = [
  'averageFrequencyMHz',
  'minimumFrequencyMHz',
  'maximumFrequencyMHz',
  'contextSwitchesPerSecond',
  'interruptsPerSecond',
  'forksPerSecond',
  'cpuIrqPercent',
] as const

/** `memory.detail`'s 19 fields (double1..double19), direct field order per §40. */
const MEMORY_DETAIL_FIELD_ORDER = [
  'memoryFreeBytes',
  'cachedBytes',
  'anonPagesBytes',
  'slabReclaimableBytes',
  'slabUnreclaimableBytes',
  'dirtyBytes',
  'writebackBytes',
  'shmemBytes',
  'pageTablesBytes',
  'kernelStackBytes',
  'committedAsBytes',
  'commitLimitBytes',
  'activeAnonBytes',
  'inactiveAnonBytes',
  'activeFileBytes',
  'inactiveFileBytes',
  'pageScanDirectPerSecond',
  'pageScanKswapdPerSecond',
  'compactionStallsPerSecond',
] as const

function numericField<T>(entity: T, field: string): number | null {
  return (entity as unknown as Record<string, number | null>)[field] ?? null
}

/** Entities-per-page for a per-entity family: how many `width`-wide entities fit in double1..19. */
function entitiesPerPage(width: number): number {
  return Math.floor(AE_V5_METRIC_DOUBLE_SLOT_COUNT / width)
}

/**
 * Chunk `entities` into pages of `entitiesPerPage(width)`, laying out each
 * entity's `fieldOrder` values sequentially within its slot, and stamping
 * each page's `ids` as `idOf(entity)` comma-joined in the same order as the
 * page's double values (blob10 — see the module doc comment). Callers should
 * pass `entities` already reordered by `orderByPageOrder` when a
 * `SlotMapping` is available, so a page's identity is stable across topology
 * generations rather than an artifact of arrival order. Returns nothing for
 * an empty array — callers only emit a page for a family whose source array
 * is actually non-empty (presence-gated).
 */
function packEntityPages<T>(
  entities: readonly T[],
  fieldOrder: readonly string[],
  width: number,
  intervalSeconds: number,
  idOf: (entity: T) => string
): { doubles: number[]; page: number; ids: string }[] {
  if (entities.length === 0) return []
  const perPage = entitiesPerPage(width)
  const pages: { doubles: number[]; page: number; ids: string }[] = []
  for (let pageIndex = 0; pageIndex * perPage < entities.length; pageIndex++) {
    const chunk = entities.slice(pageIndex * perPage, pageIndex * perPage + perPage)
    const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
    chunk.forEach((entity, entityIndex) => {
      fieldOrder.forEach((field, fieldIndex) => {
        doubles[entityIndex * width + fieldIndex] =
          numericField(entity, field) ?? AE_V5_MISSING_METRIC_SENTINEL
      })
    })
    doubles[AE_V5_DOUBLE_INTERVAL_INDEX] = intervalSeconds
    pages.push({ doubles, page: pageIndex, ids: chunk.map(idOf).join(',') })
  }
  return pages
}

/** One unpaged row per entity (managed.ingress / managed.database_proxy — no paging concept). */
function packSingleEntityRow<T>(
  entity: T,
  fieldOrder: readonly string[],
  intervalSeconds: number
): number[] {
  const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
  fieldOrder.forEach((field, i) => {
    doubles[i] = numericField(entity, field) ?? AE_V5_MISSING_METRIC_SENTINEL
  })
  doubles[AE_V5_DOUBLE_INTERVAL_INDEX] = intervalSeconds
  return doubles
}

/**
 * Pack `cpu.detail`'s single fixed-shape row: 7 host-wide scalar fields at
 * double1..double7, leaving double8..double19 spare. v4 embedded 4
 * busiest-core hotspots at double1..double12 ahead of them; v5 has no
 * per-core surface at all, so the family carries no entity identity and
 * `ids` (blob10) is empty.
 */
function packCpuDetailDoubles(
  cpuDetail: CpuDetailSampleV5,
  intervalSeconds: number
): { doubles: number[]; ids: string } {
  const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
  CPU_DETAIL_SCALAR_FIELD_ORDER.forEach((field, i) => {
    doubles[i] = numericField(cpuDetail, field) ?? AE_V5_MISSING_METRIC_SENTINEL
  })
  doubles[AE_V5_DOUBLE_INTERVAL_INDEX] = intervalSeconds
  return { doubles, ids: '' }
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

/** Shared envelope for a `"metrics"`-kind row. `sourceOrIdentity` is blob10 — see its index doc comment. */
export function buildV5MetricsBlobs(
  sample: MetricsSampleV5,
  family: HostedFamilyV5,
  page: number,
  sourceOrIdentity: string
): string[] {
  const blobs: string[] = new Array(AE_V5_BLOB_COUNT).fill('')
  blobs[AE_V5_BLOB_KIND_INDEX] = AE_V5_KIND_METRICS
  blobs[AE_V5_BLOB_FAMILY_INDEX] = family
  blobs[AE_V5_BLOB_SCHEMA_VERSION_INDEX] = String(sample.metadata.version)
  blobs[AE_V5_BLOB_COLLECTION_MODE_INDEX] = sample.metadata.collectionMode
  blobs[AE_V5_BLOB_SAMPLED_AT_INDEX] = sample.metadata.sampledAt
  blobs[AE_V5_BLOB_SEQUENCE_INDEX] = String(sample.metadata.sequence)
  blobs[AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX] = String(sample.metadata.topologyGeneration)
  blobs[AE_V5_BLOB_PAGE_INDEX] = String(page)
  blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX] = sourceOrIdentity
  return blobs
}

/** Envelope for a `"event"`-kind row — one per `sample.events` entry. */
export function buildV5EventBlobs(sample: MetricsSampleV5, event: MetricEventV5): string[] {
  const blobs: string[] = new Array(AE_V5_BLOB_COUNT).fill('')
  blobs[AE_V5_BLOB_KIND_INDEX] = AE_V5_KIND_EVENT
  blobs[AE_V5_BLOB_FAMILY_INDEX] = event.kind
  blobs[AE_V5_BLOB_SCHEMA_VERSION_INDEX] = String(sample.metadata.version)
  blobs[AE_V5_BLOB_COLLECTION_MODE_INDEX] = sample.metadata.collectionMode
  blobs[AE_V5_BLOB_SAMPLED_AT_INDEX] = event.at
  blobs[AE_V5_BLOB_SEQUENCE_INDEX] = String(sample.metadata.sequence)
  blobs[AE_V5_BLOB_TOPOLOGY_GENERATION_INDEX] = String(sample.metadata.topologyGeneration)
  blobs[AE_V5_BLOB_PAGE_INDEX] = '0'
  blobs[AE_V5_BLOB_SOURCE_OR_IDENTITY_INDEX] = event.source ?? ''
  blobs[AE_V5_BLOB_EVENT_ENTITY_ID_INDEX] = event.entityId ?? ''
  blobs[AE_V5_BLOB_EVENT_PAYLOAD_INDEX] = JSON.stringify(event.payload ?? {})
  blobs[AE_V5_BLOB_EVENT_ID_INDEX] = event.eventId
  blobs[AE_V5_BLOB_STATUS_OR_EVENT_REASON_INDEX] = event.severity
  return blobs
}

/** Envelope for a `"status"`-kind row — connection-status transitions. */
export function buildV5StatusBlobs(event: ServerStatusEvent): string[] {
  const blobs: string[] = new Array(AE_V5_BLOB_COUNT).fill('')
  blobs[AE_V5_BLOB_KIND_INDEX] = AE_V5_KIND_STATUS
  blobs[AE_V5_BLOB_SCHEMA_VERSION_INDEX] = String(METRICS_SCHEMA_VERSION_V5)
  blobs[AE_V5_BLOB_STATUS_OR_EVENT_REASON_INDEX] = event.reason
  return blobs
}

/** Build the AE v5 data point for a connection-status transition. */
export function buildStatusDataPointV5(event: ServerStatusEvent): AnalyticsEngineDataPointLikeV5 {
  const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
  doubles[AE_V5_DOUBLE_STATUS_CONNECTED_INDEX] = event.connected ? 1 : 0

  const point: AnalyticsEngineDataPointLikeV5 = {
    indexes: [event.serverId],
    doubles,
    blobs: buildV5StatusBlobs(event),
  }
  assertAnalyticsEngineDataPointShapeV5(point)
  return point
}

function buildEventDataPointV5(
  sample: AuthenticatedMetricsSampleV5,
  event: MetricEventV5
): AnalyticsEngineDataPointLikeV5 {
  const doubles = new Array<number>(AE_V5_DOUBLE_COUNT).fill(AE_V5_MISSING_METRIC_SENTINEL)
  // Event rows carry the interval weight like every other `"metrics"`-shaped
  // row. v4 left this slot at the sentinel, contradicting its own documented
  // invariant; the row-count test asserted the invariant but no fixture
  // carried an event, so it never fired.
  doubles[AE_V5_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds
  const point: AnalyticsEngineDataPointLikeV5 = {
    indexes: [sample.serverId],
    doubles,
    blobs: buildV5EventBlobs(sample, event),
  }
  assertAnalyticsEngineDataPointShapeV5(point)
  return point
}

/**
 * Build every AE v5 data point for one authenticated v5 sample.
 *
 * `host.system` and `host.io` are always emitted (one row each, even if
 * every metric in them is missing — mirroring v3's mandatory-part
 * discipline). `gpu`/`network`/`filesystem`/`block`/`hardware.physical` are
 * presence-gated: paged rows are emitted only when their source array is
 * non-empty. `managed.ingress` / `managed.database_proxy` emit one unpaged
 * row per array entry. `cpu.detail`/`memory.detail` are presence-gated
 * (emitted only when `sample.cpuDetail`/`sample.memoryDetail` is present —
 * i.e. the capability plan enables them). `events` emits one
 * `"event"`-kind row per entry. Order is deterministic: host.system, host.io,
 * gpu, network, filesystem, block, hardware.physical, managed.ingress,
 * managed.database_proxy, cpu.detail, memory.detail, event.
 *
 * `slotMapping` — resolved by the caller from the sample's own
 * `metadata.topologyGeneration` (see `types-v5.ts`'s
 * `ServerMetricsStoreV5.writeSample` doc comment) — drives identity-addressed
 * packing for `host.io`'s embedded NICs and every paged family's entity
 * order; see the module doc comment for exact behavior with and without it.
 */
export function buildMetricsDataPointsV5(
  sample: AuthenticatedMetricsSampleV5,
  slotMapping?: SlotMapping
): AnalyticsEngineDataPointLikeV5[] {
  const points: AnalyticsEngineDataPointLikeV5[] = []
  const interval = sample.metadata.intervalSeconds

  const pushMetricsPoint = (
    family: HostedFamilyV5,
    page: number,
    sourceOrIdentity: string,
    doubles: number[]
  ): void => {
    const point: AnalyticsEngineDataPointLikeV5 = {
      indexes: [sample.serverId],
      doubles,
      blobs: buildV5MetricsBlobs(sample, family, page, sourceOrIdentity),
    }
    assertAnalyticsEngineDataPointShapeV5(point)
    points.push(point)
  }

  const { nic0, nic1, paged: pagedNetworks } = resolveNetworkSlots(sample.networks, slotMapping)

  pushMetricsPoint(AE_V5_FAMILY_HOST_SYSTEM, 0, '', packHostSystemDoubles(sample))
  pushMetricsPoint(AE_V5_FAMILY_HOST_IO, 0, '', packHostIoDoubles(sample, nic0, nic1))

  const orderedGpus = orderByPageOrder(sample.gpus, (gpu) => gpu.gpuId, slotMapping?.gpuPageOrder)
  for (const { doubles, page, ids } of packEntityPages(
    orderedGpus,
    GPU_FIELD_ORDER,
    GPU_FIELD_ORDER.length,
    interval,
    (gpu) => gpu.gpuId
  )) {
    pushMetricsPoint(AE_V5_FAMILY_GPU, page, ids, doubles)
  }

  for (const { doubles, page, ids } of packEntityPages(
    pagedNetworks,
    NETWORK_FIELD_ORDER,
    NETWORK_FIELD_ORDER.length,
    interval,
    (device) => device.deviceId
  )) {
    pushMetricsPoint(AE_V5_FAMILY_NETWORK, page, ids, doubles)
  }

  const orderedFilesystems = orderByPageOrder(
    sample.filesystems,
    (fs) => fs.filesystemId,
    slotMapping?.filesystemPageOrder
  )
  for (const { doubles, page, ids } of packEntityPages(
    orderedFilesystems,
    FILESYSTEM_FIELD_ORDER,
    FILESYSTEM_FIELD_ORDER.length,
    interval,
    (fs) => fs.filesystemId
  )) {
    pushMetricsPoint(AE_V5_FAMILY_FILESYSTEM, page, ids, doubles)
  }

  const orderedBlockDevices = orderByPageOrder(
    sample.blockDevices,
    (device) => device.deviceId,
    slotMapping?.blockPageOrder
  )
  for (const { doubles, page, ids } of packEntityPages(
    orderedBlockDevices,
    BLOCK_FIELD_ORDER,
    BLOCK_FIELD_ORDER.length,
    interval,
    (device) => device.deviceId
  )) {
    pushMetricsPoint(AE_V5_FAMILY_BLOCK, page, ids, doubles)
  }

  const orderedHardwareSignals = orderByPageOrder(
    sample.hardwareSignals,
    (signal) => signal.signalId,
    slotMapping?.hardwareSignalPageOrder
  )
  for (const { doubles, page, ids } of packEntityPages(
    orderedHardwareSignals,
    HARDWARE_SIGNAL_FIELD_ORDER,
    HARDWARE_SIGNAL_FIELD_ORDER.length,
    interval,
    (signal) => signal.signalId
  )) {
    pushMetricsPoint(AE_V5_FAMILY_HARDWARE_PHYSICAL, page, ids, doubles)
  }

  for (const ingress of sample.ingressSources) {
    pushMetricsPoint(
      AE_V5_FAMILY_MANAGED_INGRESS,
      0,
      ingress.sourceId,
      packSingleEntityRow(ingress, INGRESS_FIELD_ORDER, interval)
    )
  }

  for (const proxy of sample.databaseProxies) {
    pushMetricsPoint(
      AE_V5_FAMILY_MANAGED_DATABASE_PROXY,
      0,
      proxy.sourceId,
      packSingleEntityRow(proxy, DATABASE_PROXY_FIELD_ORDER, interval)
    )
  }

  if (sample.cpuDetail) {
    const { doubles, ids } = packCpuDetailDoubles(sample.cpuDetail, interval)
    pushMetricsPoint(AE_V5_FAMILY_CPU_DETAIL, 0, ids, doubles)
  }

  if (sample.memoryDetail) {
    pushMetricsPoint(
      AE_V5_FAMILY_MEMORY_DETAIL,
      0,
      '',
      packSingleEntityRow<MemoryDetailSampleV5>(
        sample.memoryDetail,
        MEMORY_DETAIL_FIELD_ORDER,
        interval
      )
    )
  }

  for (const event of sample.events) {
    points.push(buildEventDataPointV5(sample, event))
  }

  return capToInvocationLimitV5(points, sample.serverId)
}

/**
 * Analytics Engine accepts at most this many data points per Worker
 * invocation. A metrics sample is written as one invocation, so this is a
 * hard ceiling on rows per sample, not a soft budget.
 *
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const AE_V5_MAX_DATA_POINTS_PER_INVOCATION = 250

/**
 * Families kept first when a sample would otherwise breach the invocation
 * limit, most important first. Anything not listed is lower priority than
 * everything listed.
 *
 * `host.system`/`host.io` are the mandatory baseline — losing them loses the
 * sample's identity and every universal metric. Event rows come next: they
 * are discrete state transitions (OOM kills, disk faults, link flaps) that
 * nothing else re-reports, so dropping one loses it permanently, whereas a
 * dropped entity row is one missing point in a continuous series.
 */
function invocationPriorityV5(point: AnalyticsEngineDataPointLikeV5): number {
  const kind = point.blobs?.[AE_V5_BLOB_KIND_INDEX]
  if (kind === AE_V5_KIND_METRICS) {
    const family = point.blobs?.[AE_V5_BLOB_FAMILY_INDEX]
    if (family === AE_V5_FAMILY_HOST_SYSTEM || family === AE_V5_FAMILY_HOST_IO) return 0
    return 2
  }
  if (kind === AE_V5_KIND_EVENT) return 1
  return 2
}

/**
 * Enforce {@link AE_V5_MAX_DATA_POINTS_PER_INVOCATION}.
 *
 * The capability plan keeps a real machine an order of magnitude below this
 * — the platform default tops out around 8 rows — but the plan does not bound
 * every family: `ingressSources`/`databaseProxies` are gated by a boolean
 * rather than a count, and their cardinality is scrape-derived, so a host
 * running many ingress sources alongside an event burst can reach the limit
 * with no plan override at all. The contract's own 64-entry array cap plus
 * 128 events allows 355 points in the worst case.
 *
 * Exceeding the limit is not a partial failure — the whole invocation is
 * rejected — so silently shedding the lowest-priority rows is strictly better
 * than losing the sample. Truncation is logged because it means a server is
 * reporting more than the plan intended, which is a configuration problem
 * worth seeing rather than absorbing.
 *
 * Stable-sorted by priority so the kept rows stay in emission order within
 * each tier, keeping page indices contiguous for the read path.
 */
function capToInvocationLimitV5(
  points: AnalyticsEngineDataPointLikeV5[],
  serverId: string
): AnalyticsEngineDataPointLikeV5[] {
  if (points.length <= AE_V5_MAX_DATA_POINTS_PER_INVOCATION) return points
  const ordered = points
    .map((point, index) => ({ point, index, priority: invocationPriorityV5(point) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, AE_V5_MAX_DATA_POINTS_PER_INVOCATION)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.point)
  console.warn(
    `metrics: sample for ${serverId} produced ${points.length} Analytics Engine data points, ` +
      `over the ${AE_V5_MAX_DATA_POINTS_PER_INVOCATION}-per-invocation limit; ` +
      `dropped ${points.length - ordered.length} lowest-priority rows`
  )
  return ordered
}

// ---------------------------------------------------------------------------
// Module-load invariants
// ---------------------------------------------------------------------------

/**
 * Every descriptor whose `entityScope` is `scope`, keyed by `fieldName`. Used
 * to verify a hand-declared field-order array is exactly the descriptor set
 * for that scope — no missing field, no unknown field, no duplicate.
 *
 * Deliberately does not import `metric-descriptors-v5.ts`'s private
 * `_internalV5.PER_ENTITY_CAPACITY_V5` / `HOSTED_FAMILY_CAPACITY_V5` (that
 * object is exposed for that module's own tests, not as a public API this
 * module should depend on) — this derives the equivalent guarantee from the
 * public `HOST_METRICS_METRIC_DESCRIPTORS_V5` map plus the physical
 * `AE_V5_METRIC_DOUBLE_SLOT_COUNT` page-size constant instead.
 */
function descriptorsForScope(scope: MetricEntityScopeV5): HostMetricsMetricDescriptorV5[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V5).filter(
    (descriptor) => descriptor.entityScope === scope
  )
}

function assertFieldOrderMatchesDescriptors(
  label: string,
  scope: MetricEntityScopeV5,
  fields: readonly string[]
): void {
  const expected = new Set(descriptorsForScope(scope).map((descriptor) => descriptor.fieldName))
  const actual = new Set(fields)
  if (actual.size !== fields.length) {
    throw new TypeError(`${label} field order has duplicate entries`)
  }
  for (const field of fields) {
    if (!expected.has(field)) {
      throw new TypeError(`${label} field order lists unknown field: ${scope}.${field}`)
    }
  }
  for (const field of expected) {
    if (!actual.has(field)) {
      throw new TypeError(`${label} field order is missing descriptor field: ${scope}.${field}`)
    }
  }
}

function assertWithinPageBudget(label: string, width: number): void {
  if (width > AE_V5_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `${label} has ${width} fields, exceeding the ${AE_V5_METRIC_DOUBLE_SLOT_COUNT}-slot AE page budget`
    )
  }
}

function assertFieldOrderInvariantsV5(): void {
  if (AE_V5_DOUBLE_INTERVAL_INDEX !== 19) {
    throw new TypeError('AE_V5_DOUBLE_INTERVAL_INDEX must be 19 (double20)')
  }

  // Both host.cpu and host.memory contribute an overflow field packed on the
  // host.io row, so each scope's coverage check spans its own field order plus
  // whatever it overflowed.
  const overflowFieldsFor = (scope: string) =>
    HOST_IO_OVERFLOW_FIELD_ORDER.filter((ref) => ref.scope === scope).map((ref) => ref.field)
  assertFieldOrderMatchesDescriptors('host.cpu', 'host.cpu', [
    ...HOST_CPU_FIELD_ORDER,
    ...overflowFieldsFor('host.cpu'),
  ])
  assertFieldOrderMatchesDescriptors('host.kernel', 'host.kernel', HOST_KERNEL_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors('host.memory', 'host.memory', [
    ...HOST_MEMORY_FIELD_ORDER,
    ...overflowFieldsFor('host.memory'),
  ])
  if (HOST_SYSTEM_FIELD_ORDER.length !== AE_V5_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `host.system field order has ${HOST_SYSTEM_FIELD_ORDER.length} fields, expected exactly ${AE_V5_METRIC_DOUBLE_SLOT_COUNT}`
    )
  }

  assertFieldOrderMatchesDescriptors('host.storage', 'host.storage', HOST_STORAGE_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors('host.network', 'host.network', HOST_NETWORK_FIELD_ORDER)
  const hostIoTotalSlots = HOST_IO_FIELD_ORDER.length + HOST_IO_NIC_EMBED_SLOT_COUNT
  if (hostIoTotalSlots >= AE_V5_DOUBLE_INTERVAL_INDEX) {
    throw new TypeError(
      `host.io consumes ${hostIoTotalSlots} slots, colliding with the reserved interval slot (double20)`
    )
  }
  const lastOverflowIndex =
    HOST_IO_OVERFLOW_BASE_DOUBLE_INDEX + HOST_IO_OVERFLOW_FIELD_ORDER.length - 1
  if (lastOverflowIndex >= AE_V5_DOUBLE_INTERVAL_INDEX) {
    throw new TypeError(
      `host.io overflow slot ${lastOverflowIndex} collides with the reserved interval slot (double20)`
    )
  }

  assertFieldOrderMatchesDescriptors('gpu', 'gpu', GPU_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors('network', 'network', NETWORK_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors('filesystem', 'filesystem', FILESYSTEM_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors('block', 'block', BLOCK_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors(
    'hardwareSignal',
    'hardwareSignal',
    HARDWARE_SIGNAL_FIELD_ORDER
  )
  assertWithinPageBudget('gpu per-entity width', GPU_FIELD_ORDER.length)
  assertWithinPageBudget('network per-entity width', NETWORK_FIELD_ORDER.length)
  assertWithinPageBudget('filesystem per-entity width', FILESYSTEM_FIELD_ORDER.length)
  assertWithinPageBudget('block per-entity width', BLOCK_FIELD_ORDER.length)

  assertFieldOrderMatchesDescriptors('ingress', 'ingress', INGRESS_FIELD_ORDER)
  assertFieldOrderMatchesDescriptors('databaseProxy', 'databaseProxy', DATABASE_PROXY_FIELD_ORDER)
  assertWithinPageBudget('managed.ingress', INGRESS_FIELD_ORDER.length)
  assertWithinPageBudget('managed.database_proxy', DATABASE_PROXY_FIELD_ORDER.length)

  assertFieldOrderMatchesDescriptors('cpuDetail', 'cpuDetail', CPU_DETAIL_SCALAR_FIELD_ORDER)
  // v5's cpu.detail is 7 scalars and nothing else — the 4 embedded
  // busiest-core hotspots that filled double1..double12 are gone. The
  // assertion stays strict (`!==`, not `>`) so a field added here without a
  // matching capacity bump still fails at import.
  if (CPU_DETAIL_SCALAR_FIELD_ORDER.length !== CPU_DETAIL_SLOT_COUNT) {
    throw new TypeError(
      `cpu.detail consumes ${CPU_DETAIL_SCALAR_FIELD_ORDER.length} slots, expected exactly ${CPU_DETAIL_SLOT_COUNT}`
    )
  }

  assertFieldOrderMatchesDescriptors('memoryDetail', 'memoryDetail', MEMORY_DETAIL_FIELD_ORDER)
  if (MEMORY_DETAIL_FIELD_ORDER.length !== AE_V5_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `memory.detail field order has ${MEMORY_DETAIL_FIELD_ORDER.length} fields, expected exactly ${AE_V5_METRIC_DOUBLE_SLOT_COUNT}`
    )
  }
}
assertFieldOrderInvariantsV5()

/** Exposed for tests that need to exercise the throw behavior without waiting on module-load side effects. */
export const _internalFieldMapV5 = {
  assertFieldOrderMatchesDescriptors,
  assertWithinPageBudget,
  entitiesPerPage,
}

// ---------------------------------------------------------------------------
// Query-side lookups — the read path (`sql-api-v5.ts`) resolves a requested
// canonical/field name to its physical AE double slot through these, so the
// field ordering declared above stays this module's only copy.
// ---------------------------------------------------------------------------

export { entitiesPerPage }

/** Per-entity-family field order + width, keyed by `HostedFamilyV5`. */
export const PER_ENTITY_FIELD_ORDER_V5: Record<
  Extract<HostedFamilyV5, 'gpu' | 'network' | 'filesystem' | 'block' | 'hardware.physical'>,
  readonly string[]
> = {
  gpu: GPU_FIELD_ORDER,
  network: NETWORK_FIELD_ORDER,
  filesystem: FILESYSTEM_FIELD_ORDER,
  block: BLOCK_FIELD_ORDER,
  'hardware.physical': HARDWARE_SIGNAL_FIELD_ORDER,
}

/**
 * The only `network`-family fields individually reconstructable from
 * `host.io`'s embedded NIC slots — receive/transmit bytes-per-second embed
 * verbatim (see `packHostIoDoubles`), but the 4 error/drop rates are only
 * ever embedded pre-summed as one combined problem-packets rate, with no way
 * to recover the individual components. Exported so the query layer
 * (`sql-api-v5.ts`) knows exactly which requested `network` fields it can
 * answer for a topology's slot-mapped NICs — every other requested field
 * resolves to `null` for those two entities, never a fabricated split of the
 * combined rate.
 */
export const HOST_IO_EMBEDDED_NIC_FIELDS = [
  'receiveBytesPerSecond',
  'transmitBytesPerSecond',
] as const

/**
 * 0-based `host.io` double index for slot-mapped NIC `slot` (`0` =
 * `SlotMapping.normalNicSlots[0]`, `1` = `normalNicSlots[1]`)'s `field` — one of
 * {@link HOST_IO_EMBEDDED_NIC_FIELDS}. Mirrors `packHostIoDoubles`'s embed
 * layout (`embedBase + slot * 3` for receive, `+ 1` for transmit; `+ 2` is
 * the combined problem-packets rate, not individually addressable here).
 * Used by the read path to reconstruct a queryable `network` entity series
 * for a topology's slot-mapped NICs, which never page as standalone
 * `network` rows on this backend (see the module doc comment).
 */
export function hostIoEmbeddedNicDoubleIndex(
  slot: 0 | 1,
  field: (typeof HOST_IO_EMBEDDED_NIC_FIELDS)[number]
): number {
  const embedBase = HOST_IO_FIELD_ORDER.length
  const slotBase = embedBase + slot * 3
  return field === 'receiveBytesPerSecond' ? slotBase : slotBase + 1
}

/** Single-row-per-entity family field order (`managed.ingress` / `managed.database_proxy` — no paging). */
export const SINGLE_ROW_FIELD_ORDER_V5: Record<
  Extract<HostedFamilyV5, 'managed.ingress' | 'managed.database_proxy'>,
  readonly string[]
> = {
  'managed.ingress': INGRESS_FIELD_ORDER,
  'managed.database_proxy': DATABASE_PROXY_FIELD_ORDER,
}

/**
 * Resolve a fixed-shape-family-scoped field to its physical AE double slot:
 * which single-row family carries it (`host.system` / `host.io` /
 * `cpu.detail` / `memory.detail`) and its 0-based double index. `cpu.detail`
 * scalar fields (scope `cpuDetail`) now start at double1, since v5 removed
 * the embedded hotspot slots that used to precede them. Throws for any
 * scope/field this module doesn't pack as a
 * fixed single-row double slot (per-entity families, or an unknown field).
 */
export function doubleIndexForHostField(
  scope: MetricEntityScopeV5,
  field: string
): {
  family: Extract<HostedFamilyV5, 'host.system' | 'host.io' | 'cpu.detail' | 'memory.detail'>
  doubleIndex: number
} {
  const systemIndex = HOST_SYSTEM_FIELD_ORDER.findIndex(
    (ref) => ref.scope === scope && ref.field === field
  )
  if (systemIndex !== -1) {
    return { family: 'host.system', doubleIndex: systemIndex }
  }
  const ioIndex = HOST_IO_FIELD_ORDER.findIndex((ref) => ref.scope === scope && ref.field === field)
  if (ioIndex !== -1) {
    return { family: 'host.io', doubleIndex: ioIndex }
  }
  const overflowIndex = HOST_IO_OVERFLOW_FIELD_ORDER.findIndex(
    (ref) => ref.scope === scope && ref.field === field
  )
  if (overflowIndex !== -1) {
    return {
      family: 'host.io',
      doubleIndex: HOST_IO_OVERFLOW_BASE_DOUBLE_INDEX + overflowIndex,
    }
  }
  if (scope === 'cpuDetail') {
    const scalarIndex = CPU_DETAIL_SCALAR_FIELD_ORDER.indexOf(
      field as (typeof CPU_DETAIL_SCALAR_FIELD_ORDER)[number]
    )
    if (scalarIndex !== -1) {
      return {
        family: 'cpu.detail',
        doubleIndex: scalarIndex,
      }
    }
  }
  if (scope === 'memoryDetail') {
    const memoryIndex = MEMORY_DETAIL_FIELD_ORDER.indexOf(
      field as (typeof MEMORY_DETAIL_FIELD_ORDER)[number]
    )
    if (memoryIndex !== -1) {
      return { family: 'memory.detail', doubleIndex: memoryIndex }
    }
  }
  throw new TypeError(`no AE v5 host double slot for field "${scope}.${field}"`)
}

/**
 * 0-based double index for entity `slotPosition` (0-based, within a page of
 * `width`-wide entities) and `fieldIndex` (0-based, within that family's
 * field order). Callers must check `slotPosition < entitiesPerPage(width)`
 * themselves — this does not re-validate the page budget.
 */
export function slotDoubleIndex(width: number, slotPosition: number, fieldIndex: number): number {
  return slotPosition * width + fieldIndex
}
