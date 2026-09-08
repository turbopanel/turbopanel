/**
 * Cloudflare Analytics Engine positional field map for the current metrics
 * contract — the single source of truth for the double1..double20 /
 * blob1..blob20 layout on the `turbopanel_server_metrics_v6` dataset.
 *
 * Metrics are grouped by entity/family (`metric-descriptors.ts`'s
 * `hostedFamily`). This module is the packing layer for the active
 * Analytics Engine dataset.
 *
 * Slot assignment is identity-addressed when a `SlotMapping` is available
 * (`client/servers/topology-slot-mapping.ts`'s `computeSlotMapping`, resolved
 * by the ingest route from the sample's own `metadata.topologyGeneration` —
 * see {@link buildMetricsDataPoints}'s `slotMapping` parameter and
 * `types.ts`'s `ServerMetricsStore.writeSample` doc comment):
 *
 *  - `host.io`'s otherwise-unused double14..double19 embed the first two
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
  type DiagnosticsSample,
  type DockerUsageSample,
  type MetricEvent,
  METRICS_SCHEMA_VERSION,
  type MetricsSample,
  type NetworkDeviceSample,
  type RouterSample,
  STORAGE_ENGINE_FIELD_NAMES,
  STORAGE_ENGINE_KEYS,
  STORAGE_FLAT_FIELD_NAMES,
  storageEngineFieldName,
  type StorageEngineKey,
  type StorageSample,
} from "../../contract.ts";
import {
  DIAGNOSTICS_CPU_FIELD_NAMES,
  DIAGNOSTICS_MEMORY_FIELD_NAMES,
  DOCKER_USAGE_FIELD_NAMES,
  HOST_METRICS_METRIC_DESCRIPTORS,
  type HostedFamily,
  type HostMetricsMetricDescriptor,
  type MetricEntityScope,
} from "../../metric-descriptors.ts";
import type {
  AuthenticatedMetricsSample,
  ServerStatusEvent,
  SlotMapping,
} from "../../types.ts";

/** Analytics Engine dataset for the current metrics contract. */
export const AE_DATASET_NAME = "turbopanel_server_metrics_v6";

export const AE_DOUBLE_COUNT = 20;
export const AE_BLOB_COUNT = 20;

/**
 * Physical AE row budget for metric-value double slots (double1..double19) —
 * one reserved interval slot on double20.
 */
export const AE_METRIC_DOUBLE_SLOT_COUNT = 19;

/** double20 on every `"metrics"`-kind row — the sample's `intervalSeconds`. */
export const AE_DOUBLE_INTERVAL_INDEX = 19;

/** double1 on `"status"`-kind rows — connected (1) / disconnected (0). */
export const AE_DOUBLE_STATUS_CONNECTED_INDEX = 0;

/**
 * Missing-metric sentinel (AE doubles have no null; 0 would silently skew
 * averages; all host metrics are >= 0).
 */
export const AE_MISSING_METRIC_SENTINEL = -1e308;

// ---------------------------------------------------------------------------
// Envelope blob indexes (0-based — `blobColumn` maps to `blob<index+1>`).
// ---------------------------------------------------------------------------

/** blob1 — row-kind discriminator: `"metrics"` / `"event"` / `"status"`. */
export const AE_BLOB_KIND_INDEX = 0;
/**
 * blob2 — on `"metrics"` rows, the {@link HostedFamily}; on `"event"` rows,
 * the event's `kind` (`MetricEventKind`); empty on `"status"` rows.
 */
export const AE_BLOB_FAMILY_INDEX = 1;
/** blob3 — schema version (stringified integer, every row kind). */
export const AE_BLOB_SCHEMA_VERSION_INDEX = 2;
/**
 * blob4 — reserved, always empty in v6. v5 stamped the sample's collection
 * mode (`"baseline"` / `"live"`) here; v6 dropped the concept — cadence is
 * carried by `intervalSeconds` (double20) alone, which is the only thing any
 * reader ever needed. The slot stays declared so a future envelope field can
 * take it without renumbering blob5+.
 */
export const AE_BLOB_COLLECTION_MODE_INDEX = 3;
/**
 * blob5 — sample timestamp. On `"metrics"` rows, `metadata.sampledAt`; on
 * `"event"` rows, the event's own `at` (more precise than the enclosing
 * sample's timestamp); empty on `"status"` rows (AE stamps its own ingestion
 * timestamp there, matching v3).
 */
export const AE_BLOB_SAMPLED_AT_INDEX = 4;
/** blob6 — enclosing sample's sequence (stringified integer); empty on `"status"` rows. */
export const AE_BLOB_SEQUENCE_INDEX = 5;
/** blob7 — `metadata.topologyGeneration` (stringified integer); empty on `"status"` rows. */
export const AE_BLOB_TOPOLOGY_GENERATION_INDEX = 6;
/**
 * blob8 — `AuthenticatedMetricsSample.capabilityPlanGeneration` (stringified
 * integer). Empty when ingest did not resolve a generation (record failure
 * or a store path that never ran plan resolution).
 */
export const AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX = 7;
/** blob9 — page index within a paged per-entity family (`"0"` for unpaged rows). */
export const AE_BLOB_PAGE_INDEX = 8;
/**
 * blob10 — family-conditional: `sourceId` for `managed.ingress` /
 * `managed.database_proxy` rows, comma-joined per-page entity ids (in the
 * same order as that page's double values) for `gpu` / `network` /
 * `filesystem` / `block` / `hardware.physical` rows, `event.source` for
 * `"event"` rows, empty on `host.system` / `host.io` / `managed.router` /
 * `managed.storage` / `managed.docker` / `host.diagnostics` (the five
 * host-wide singleton families carry no entity identity of their own).
 */
export const AE_BLOB_SOURCE_OR_IDENTITY_INDEX = 9;
/** blob11 — `"event"` rows only: `event.entityId` (empty when absent). */
export const AE_BLOB_EVENT_ENTITY_ID_INDEX = 10;
/** blob12 — `"event"` rows only: `JSON.stringify(event.payload ?? {})`. */
export const AE_BLOB_EVENT_PAYLOAD_INDEX = 11;
/** blob13 — `"event"` rows only: `event.eventId`. Empty on every other row kind. */
export const AE_BLOB_EVENT_ID_INDEX = 12;
/** blob14..blob16 stay reserved-empty on every row kind. */
export const AE_RESERVED_MID_BLOB_COUNT = 3;
/**
 * blob17 — `"status"` rows: {@link ServerStatusEvent.reason}. `"event"` rows:
 * the event's `severity`. Empty on `"metrics"` rows.
 */
export const AE_BLOB_STATUS_OR_EVENT_REASON_INDEX = 16;
/** blob18..blob20 stay reserved-empty on every row kind. */
export const AE_RESERVED_TRAILING_BLOB_COUNT = 3;

/** blob1 discriminator values. */
export const AE_KIND_METRICS = "metrics";
export const AE_KIND_EVENT = "event";
export const AE_KIND_STATUS = "status";

/** blob2 discriminator values for `"metrics"` rows — mirrors {@link HostedFamily} exactly. */
export const AE_FAMILY_HOST_SYSTEM: HostedFamily = "host.system";
export const AE_FAMILY_HOST_IO: HostedFamily = "host.io";
export const AE_FAMILY_GPU: HostedFamily = "gpu";
export const AE_FAMILY_NETWORK: HostedFamily = "network";
export const AE_FAMILY_FILESYSTEM: HostedFamily = "filesystem";
export const AE_FAMILY_BLOCK: HostedFamily = "block";
export const AE_FAMILY_HARDWARE_PHYSICAL: HostedFamily = "hardware.physical";
export const AE_FAMILY_MANAGED_INGRESS: HostedFamily = "managed.ingress";
export const AE_FAMILY_MANAGED_DATABASE_PROXY: HostedFamily =
  "managed.database_proxy";
export const AE_FAMILY_MANAGED_ROUTER: HostedFamily = "managed.router";
export const AE_FAMILY_MANAGED_STORAGE: HostedFamily = "managed.storage";
export const AE_FAMILY_MANAGED_DOCKER: HostedFamily = "managed.docker";
export const AE_FAMILY_HOST_DIAGNOSTICS: HostedFamily = "host.diagnostics";

/**
 * Physical column name for the authenticated serverId identity slot
 * (`indexes[0]` on the write path, `index1` on the SQL read path).
 */
export const AE_INDEX_SERVER_ID_COLUMN = "index1";

/** Physical column name for the AE ingestion timestamp. */
export const AE_TIMESTAMP_COLUMN = "timestamp";

/** Narrow AE data-point shape mirroring Workers `AnalyticsEngineDataPoint`. */
export type AnalyticsEngineDataPointLike = {
  indexes: [string];
  doubles: number[];
  blobs: string[];
};

export function blobColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_BLOB_COUNT) {
    throw new TypeError(`invalid AE v5 blob index: ${index}`);
  }
  return `blob${index + 1}`;
}

export function doubleColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= AE_DOUBLE_COUNT) {
    throw new TypeError(`invalid AE v5 double index: ${index}`);
  }
  return `double${index + 1}`;
}

/** AE column for the interval-seconds weight slot (`double20`). */
export function intervalSecondsColumn(): string {
  return doubleColumn(AE_DOUBLE_INTERVAL_INDEX);
}

/** AE column for status-row connected (1/0). */
export function statusConnectedColumn(): string {
  return doubleColumn(AE_DOUBLE_STATUS_CONNECTED_INDEX);
}

/** AE column for status-row transition reason / event-row severity. */
export function statusReasonColumn(): string {
  return blobColumn(AE_BLOB_STATUS_OR_EVENT_REASON_INDEX);
}

/** Test-only: assert doubles/blobs lengths (used by shape-drift tests). */
export function assertAnalyticsEngineDataPointShape(point: {
  doubles: number[];
  blobs: string[];
}): void {
  if (point.doubles.length !== AE_DOUBLE_COUNT) {
    throw new TypeError(
      `AE v5 doubles length ${point.doubles.length} !== ${AE_DOUBLE_COUNT}`,
    );
  }
  if (point.blobs.length !== AE_BLOB_COUNT) {
    throw new TypeError(
      `AE v5 blobs length ${point.blobs.length} !== ${AE_BLOB_COUNT}`,
    );
  }
}

// ---------------------------------------------------------------------------
// host.system / host.io — fixed-shape single-row families. Field order is a
// hand-declared, test-pinned array (not object insertion order), verified at
// module load against `HOST_METRICS_METRIC_DESCRIPTORS` so it can never
// silently drift from the actual descriptor set.
// ---------------------------------------------------------------------------

const HOST_CPU_FIELD_ORDER = [
  "busyPercent",
  "userPercent",
  "systemPercent",
  "iowaitPercent",
  "stealPercent",
  "softirqPercent",
  "pressureSomePercent",
  "saturatedCoreCount",
  "procsRunning",
  "procsBlocked",
  "processCount",
] as const;

const HOST_KERNEL_FIELD_ORDER = [
  "fileHandlesUsedPercent",
  "conntrackUsedPercent",
] as const;

const HOST_MEMORY_FIELD_ORDER = [
  "usedBytes",
  "cachedFilesBytes",
  "swapUsedBytes",
  "pressureSomePercent",
  "pressureFullPercent",
  "swapInBytesPerSecond",
  "swapOutBytesPerSecond",
  "majorPageFaultsPerSecond",
] as const;

const HOST_STORAGE_FIELD_ORDER = [
  "ioPressureSomePercent",
  "ioPressureFullPercent",
  "diskReadBytesPerSecond",
  "diskWriteBytesPerSecond",
  "diskLatencyMs",
  "rootFilesystemAvailableBytes",
  "rootFilesystemFreeInodes",
] as const;

const HOST_NETWORK_FIELD_ORDER = [
  "tcpRetransmitPercent",
  "softnetDropsPerSecond",
] as const;

type HostFieldRef = { scope: MetricEntityScope; field: string };

/**
 * A deliberately-empty `host.io` double slot, reserved for the next field its
 * neighbouring group grows. Holding the gap here (rather than appending new
 * fields after the NIC embed) is what lets storage or network gain a metric
 * without renumbering every slot the read path already resolves.
 */
const HOST_IO_SPARE_SLOT = null;

function hostFieldRefs(
  scope: MetricEntityScope,
  fields: readonly string[],
): HostFieldRef[] {
  return fields.map((field) => ({ scope, field }));
}

/**
 * host.system's 19 double slots (double1..double19), in declared order:
 * `host.cpu`'s 11 fields then `host.memory`'s 8. v6 re-laid this out so the
 * family is exactly its two scopes with nothing overflowed — v5 packed
 * `host.kernel` here and pushed `processCount`/`majorPageFaultsPerSecond`
 * onto the host.io row to fit.
 */
const HOST_SYSTEM_FIELD_ORDER: readonly HostFieldRef[] = [
  ...hostFieldRefs("host.cpu", HOST_CPU_FIELD_ORDER),
  ...hostFieldRefs("host.memory", HOST_MEMORY_FIELD_ORDER),
];

/**
 * host.io's 13 leading double slots (double1..double13): `host.kernel`
 * (double1..double2), `host.storage` (double3..double9), one spare
 * (double10), `host.network` (double11..double12), one spare (double13).
 * The NIC embed starts immediately after, at double14.
 */
const HOST_IO_FIELD_ORDER: readonly (HostFieldRef | null)[] = [
  ...hostFieldRefs("host.kernel", HOST_KERNEL_FIELD_ORDER),
  ...hostFieldRefs("host.storage", HOST_STORAGE_FIELD_ORDER),
  HOST_IO_SPARE_SLOT,
  ...hostFieldRefs("host.network", HOST_NETWORK_FIELD_ORDER),
  HOST_IO_SPARE_SLOT,
];

/**
 * host.io's 6 NIC-embedded double slots (double14..double19): 3 values
 * (receive bytes/s, transmit bytes/s, combined problem-packets/s) for each of
 * the first two `networks[]` entries — see the module doc comment. They start
 * at `HOST_IO_FIELD_ORDER.length` (13), immediately after the descriptor and
 * spare slots, and run up to but not including the reserved interval slot
 * (double20).
 */
const HOST_IO_NIC_EMBED_SLOT_COUNT = 6;

function hostFieldValue(
  sample: MetricsSample,
  ref: HostFieldRef,
): number | null {
  const groupKey = ref.scope.slice(
    "host.".length,
  ) as keyof MetricsSample["host"];
  const group = sample.host[groupKey] as unknown as Record<
    string,
    number | null
  >;
  return group[ref.field] ?? null;
}

/** Sum of a NIC's four error/drop rates, or the sentinel if any input is missing. */
function combinedProblemPacketsPerSecond(
  nic: NetworkDeviceSample | undefined,
): number {
  if (!nic) return AE_MISSING_METRIC_SENTINEL;
  const parts = [
    nic.receiveErrorsPerSecond,
    nic.transmitErrorsPerSecond,
    nic.receiveDropsPerSecond,
    nic.transmitDropsPerSecond,
  ];
  if (parts.includes(null)) return AE_MISSING_METRIC_SENTINEL;
  return (parts as number[]).reduce((sum, value) => sum + value, 0);
}

function packHostSystemDoubles(sample: MetricsSample): number[] {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  HOST_SYSTEM_FIELD_ORDER.forEach((ref, i) => {
    doubles[i] = hostFieldValue(sample, ref) ?? AE_MISSING_METRIC_SENTINEL;
  });
  doubles[AE_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds;
  return doubles;
}

function packHostIoDoubles(
  sample: MetricsSample,
  nic0: NetworkDeviceSample | undefined,
  nic1: NetworkDeviceSample | undefined,
): number[] {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  HOST_IO_FIELD_ORDER.forEach((ref, i) => {
    // A spare slot stays at the sentinel the array was filled with.
    if (ref) {
      doubles[i] = hostFieldValue(sample, ref) ?? AE_MISSING_METRIC_SENTINEL;
    }
  });
  const embedBase = HOST_IO_FIELD_ORDER.length;
  doubles[embedBase] = nic0?.receiveBytesPerSecond ??
    AE_MISSING_METRIC_SENTINEL;
  doubles[embedBase + 1] = nic0?.transmitBytesPerSecond ??
    AE_MISSING_METRIC_SENTINEL;
  doubles[embedBase + 2] = combinedProblemPacketsPerSecond(nic0);
  doubles[embedBase + 3] = nic1?.receiveBytesPerSecond ??
    AE_MISSING_METRIC_SENTINEL;
  doubles[embedBase + 4] = nic1?.transmitBytesPerSecond ??
    AE_MISSING_METRIC_SENTINEL;
  doubles[embedBase + 5] = combinedProblemPacketsPerSecond(nic1);
  doubles[AE_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds;
  return doubles;
}

/** How many `normalNicSlots` entries `host.io` embeds — slots 1 and 2; every later slot pages. */
export const HOST_IO_EMBEDDED_NIC_SLOT_COUNT = 2;

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
  networks: readonly NetworkDeviceSample[],
  slotMapping: SlotMapping | undefined,
): {
  nic0: NetworkDeviceSample | undefined;
  nic1: NetworkDeviceSample | undefined;
  paged: NetworkDeviceSample[];
} {
  if (!slotMapping) {
    return { nic0: networks[0], nic1: networks[1], paged: networks.slice(2) };
  }
  const byId = new Map(networks.map((device) => [device.deviceId, device]));
  const [slot1, slot2] = slotMapping.normalNicSlots;
  const nic0 = slot1 ? byId.get(slot1) : undefined;
  const nic1 = slot2 ? byId.get(slot2) : undefined;
  const excluded = new Set<string>([
    ...slotMapping.fabricDeviceIds,
    ...slotMapping.normalNicSlots.slice(0, HOST_IO_EMBEDDED_NIC_SLOT_COUNT),
  ]);
  const pagedSlots = slotMapping.normalNicSlots
    .slice(HOST_IO_EMBEDDED_NIC_SLOT_COUNT)
    .map((id) => byId.get(id))
    .filter((device): device is NetworkDeviceSample => device !== undefined);
  const pagedSlotIds = new Set(pagedSlots.map((device) => device.deviceId));
  const paged = [
    ...pagedSlots,
    ...networks.filter(
      (device) =>
        !excluded.has(device.deviceId) && !pagedSlotIds.has(device.deviceId),
    ),
  ];
  return { nic0, nic1, paged };
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
  pageOrder: readonly string[] | undefined,
): T[] {
  if (!pageOrder) return [...entities];
  const byId = new Map(
    entities.map((entity) => [idOf(entity), entity] as const),
  );
  const ordered: T[] = [];
  for (const id of pageOrder) {
    const entity = byId.get(id);
    if (entity !== undefined) {
      ordered.push(entity);
      byId.delete(id);
    }
  }
  for (const entity of entities) {
    if (byId.has(idOf(entity))) ordered.push(entity);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Per-entity paged families (gpu, network, filesystem, block) and the
// hardware-physical signal family. Every entity's fields are laid out
// sequentially within its slot; a page's trailing unused slots (before
// double20) stay sentinel by construction (the doubles array starts
// sentinel-filled).
// ---------------------------------------------------------------------------

// GPU temperature/memory-temperature/power are `hardware.physical` signals
// keyed to the owning GPU, not `gpu` fields — 6 wide, so 3 GPUs per page.
const GPU_FIELD_ORDER = [
  "utilizationPercent",
  "memoryUsedBytes",
  "memoryActivityPercent",
  "pcieReceiveBytesPerSecond",
  "pcieTransmitBytesPerSecond",
  "throttlePercent",
] as const;

const NETWORK_FIELD_ORDER = [
  "receiveBytesPerSecond",
  "transmitBytesPerSecond",
  "receiveErrorsPerSecond",
  "transmitErrorsPerSecond",
  "receiveDropsPerSecond",
  "transmitDropsPerSecond",
] as const;

const FILESYSTEM_FIELD_ORDER = ["availableBytes", "freeInodes"] as const;

// Drive temperature is a `hardware.physical` signal keyed to the owning
// drive, not a `block` field — 8 wide, still 2 drives per page.
const BLOCK_FIELD_ORDER = [
  "readBytesPerSecond",
  "writeBytesPerSecond",
  "readOpsPerSecond",
  "writeOpsPerSecond",
  "readLatencyMs",
  "writeLatencyMs",
  "utilizationPercent",
  "queueDepth",
] as const;

const HARDWARE_SIGNAL_FIELD_ORDER = ["value"] as const;

/**
 * A deliberately-empty single-row-family double slot, reserved for the next
 * field its neighbouring group grows — the same idiom `HOST_IO_SPARE_SLOT`
 * applies to `host.io`. Holding the gap in place (rather than appending new
 * fields at the end) is what lets a family gain a metric without renumbering
 * every slot the read path already resolves.
 */
const SINGLE_ROW_SPARE_SLOT = null;

/**
 * `managed.ingress`'s 19 double slots (double1..double19), filling the page
 * exactly with no spares: the 8 request/response/byte counters, the raw
 * per-interval duration sum, the 6 cumulative-`le` latency buckets, and the
 * 4 in-flight/upstream/retry fields. Percentiles and the average latency are
 * derived from these at read time (`query/derived-metrics.ts`), never stored.
 */
const INGRESS_FIELD_ORDER: readonly (string | null)[] = [
  "requests",
  "responses2xx",
  "responses3xx",
  "responses4xx",
  "responses5xx",
  "requestErrors",
  "requestBytes",
  "responseBytes",
  "requestDurationSecondsSum",
  "bucket10ms",
  "bucket50ms",
  "bucket100ms",
  "bucket500ms",
  "bucket1s",
  "bucket5s",
  "requestsInFlight",
  "upstreamsHealthy",
  "upstreamsTotal",
  "retries",
];

/**
 * `managed.database_proxy`'s 19 double slots: 17 fields grouped
 * query / latency / client-connection / backend-connection / backend-health,
 * with one spare held at the end of the query group (double6) and one at the
 * end of the connection group (double15) so either can grow in place.
 */
const DATABASE_PROXY_FIELD_ORDER: readonly (string | null)[] = [
  "queries",
  "slowQueries",
  "queryLatencyMsAvg",
  "backendLatencyMsAvg",
  "activeTransactions",
  SINGLE_ROW_SPARE_SLOT,
  "clientConnections",
  "clientConnectionsCreated",
  "clientConnectionsAborted",
  "connectionsRejectedMaxConns",
  "backendConnections",
  "backendConnectionsCreated",
  "backendConnectionsAborted",
  "connectionErrors",
  SINGLE_ROW_SPARE_SLOT,
  "backendsUp",
  "backendsTotal",
  "bytesFromBackends",
  "bytesToBackends",
];

/**
 * `managed.router`'s 19 double slots: 12 fields plus 7 spares. Host-wide and
 * singleton like `host.diagnostics` — one row per sample, no entity id, so
 * blob10 stays empty. Spares sit between the traffic group and the config/TLS
 * group (double9, double11..double12) and trail the row (double16..double19)
 * so the router-health surface a later phase adds lands in place rather than
 * renumbering resolved slots.
 */
const ROUTER_FIELD_ORDER: readonly (string | null)[] = [
  "backendsUp",
  "backendsTotal",
  "servicesTotal",
  "routersTotal",
  "retries",
  "backendErrors5xx",
  "backendLatencyMsAvg",
  "backendRequests",
  SINGLE_ROW_SPARE_SLOT,
  "httpOpenConnections",
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  "configReloads",
  "configLastReloadAgeSeconds",
  "tlsCertSoonestExpiryDays",
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
];

/**
 * `managed.storage`'s 19 double slots, filling the page exactly with no
 * spares: the 4 `*UsedBytes` directory totals, the 3 `*FreeBytes` filesystem
 * headrooms, then the three managed-database engines' 4 census readings
 * apiece (`postgres`, `mysql`, `mariadb`, in that order).
 *
 * Each entry names both where the value lives on the wire (`group`/`field` —
 * the engine readings are nested under `StorageSample.postgres` and friends)
 * and the flattened descriptor `fieldName` (`name`) the read path resolves
 * by, since the family spans four sub-objects but one flat AE row. Same idiom
 * as {@link DIAGNOSTICS_FIELD_ORDER}, widened by the flattened name because
 * `instancesRunning` repeats across all three engines.
 */
type StorageFieldRef = {
  group: StorageEngineKey | null;
  field: string;
  name: string;
};

const STORAGE_FIELD_ORDER: readonly StorageFieldRef[] = [
  ...STORAGE_FLAT_FIELD_NAMES.map((field) => ({
    group: null,
    field,
    name: field,
  })),
  ...STORAGE_ENGINE_KEYS.flatMap((engine) =>
    STORAGE_ENGINE_FIELD_NAMES.map((field) => ({
      group: engine,
      field,
      name: storageEngineFieldName(engine, field),
    }))
  ),
];

/** Flat `fieldName` list for `managed.storage`, in physical slot order. */
export const STORAGE_SLOT_FIELD_NAMES: readonly string[] = STORAGE_FIELD_ORDER
  .map(
    (ref) => ref.name,
  );

/**
 * `managed.docker`'s 19 double slots: the 10 `GET /system/df` breakdown
 * fields at double1..double10, then 9 reserved spares. Host-wide and
 * singleton like `managed.router`, so blob10 stays empty.
 *
 * The spares trail the row rather than sitting between groups because the
 * depth this family will grow (per-image / per-volume rollups) appends to the
 * existing breakdown rather than widening one of its groups.
 */
const DOCKER_USAGE_FIELD_ORDER: readonly (string | null)[] = [
  "layersBytes",
  "imagesCount",
  "imagesReclaimableBytes",
  "containersBytes",
  "containersCount",
  "volumesBytes",
  "volumesCount",
  "volumesReclaimableBytes",
  "buildCacheBytes",
  "buildCacheReclaimableBytes",
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
  SINGLE_ROW_SPARE_SLOT,
];

/** A slot array's real (non-spare) field names — what descriptor-agreement checks compare against. */
function declaredFields(order: readonly (string | null)[]): string[] {
  return order.filter((field): field is string => field !== null);
}

/**
 * `host.diagnostics`'s 19 double slots (double1..double19): the CPU half's 7
 * frequency/scheduling scalars followed by the memory half's 12
 * meminfo/vmstat gauges and rates. Each entry names which half of
 * `DiagnosticsSample` it reads from, since the merged family spans two
 * sub-objects but one flat AE row.
 */
type DiagnosticsFieldRef = { group: keyof DiagnosticsSample; field: string };

const DIAGNOSTICS_FIELD_ORDER: readonly DiagnosticsFieldRef[] = [
  ...DIAGNOSTICS_CPU_FIELD_NAMES.map((field) => ({
    group: "cpu" as const,
    field,
  })),
  ...DIAGNOSTICS_MEMORY_FIELD_NAMES.map((field) => ({
    group: "memory" as const,
    field,
  })),
];

/** Flat `fieldName` list for `host.diagnostics`, in physical slot order. */
export const DIAGNOSTICS_FIELD_NAMES: readonly string[] =
  DIAGNOSTICS_FIELD_ORDER.map(
    (ref) => ref.field,
  );

function numericField<T>(entity: T, field: string): number | null {
  return (entity as unknown as Record<string, number | null>)[field] ?? null;
}

/** Entities-per-page for a per-entity family: how many `width`-wide entities fit in double1..19. */
function entitiesPerPage(width: number): number {
  return Math.floor(AE_METRIC_DOUBLE_SLOT_COUNT / width);
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
  idOf: (entity: T) => string,
): { doubles: number[]; page: number; ids: string }[] {
  if (entities.length === 0) return [];
  const perPage = entitiesPerPage(width);
  const pages: { doubles: number[]; page: number; ids: string }[] = [];
  for (let pageIndex = 0; pageIndex * perPage < entities.length; pageIndex++) {
    const chunk = entities.slice(
      pageIndex * perPage,
      pageIndex * perPage + perPage,
    );
    const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
      AE_MISSING_METRIC_SENTINEL,
    );
    chunk.forEach((entity, entityIndex) => {
      fieldOrder.forEach((field, fieldIndex) => {
        doubles[entityIndex * width + fieldIndex] =
          numericField(entity, field) ?? AE_MISSING_METRIC_SENTINEL;
      });
    });
    doubles[AE_DOUBLE_INTERVAL_INDEX] = intervalSeconds;
    pages.push({ doubles, page: pageIndex, ids: chunk.map(idOf).join(",") });
  }
  return pages;
}

/**
 * One unpaged row per entity (managed.ingress / managed.database_proxy — no
 * paging concept). `fieldOrder` is a *slot* array, not a field list: a `null`
 * entry is a reserved spare that stays at the sentinel the array was filled
 * with, so a field's array position is always its physical double index (the
 * same rule `packHostIoDoubles` follows for `HOST_IO_SPARE_SLOT`).
 */
function packSingleEntityRow<T>(
  entity: T,
  fieldOrder: readonly (string | null)[],
  intervalSeconds: number,
): number[] {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  fieldOrder.forEach((field, i) => {
    if (field === null) return;
    doubles[i] = numericField(entity, field) ?? AE_MISSING_METRIC_SENTINEL;
  });
  doubles[AE_DOUBLE_INTERVAL_INDEX] = intervalSeconds;
  return doubles;
}

/**
 * Pack `managed.router`'s single fixed-shape row — the host's one shared
 * ingress router. Host-wide with no entity identity (blob10 stays empty),
 * exactly like {@link packDiagnosticsDoubles}; reserved spare slots stay
 * sentinel the same way {@link packSingleEntityRow}'s do.
 */
function packRouterDoubles(
  router: RouterSample,
  intervalSeconds: number,
): number[] {
  return packSingleEntityRow(router, ROUTER_FIELD_ORDER, intervalSeconds);
}

/**
 * Pack `host.diagnostics`'s single fixed-shape row: the 7 CPU scalars at
 * double1..double7 followed by the 12 memory gauges/rates at
 * double8..double19, filling the page exactly. The family is host-scoped and
 * carries no entity identity, so blob10 stays empty.
 */
function packDiagnosticsDoubles(
  diagnostics: DiagnosticsSample,
  intervalSeconds: number,
): number[] {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  DIAGNOSTICS_FIELD_ORDER.forEach((ref, i) => {
    doubles[i] = numericField(diagnostics[ref.group], ref.field) ??
      AE_MISSING_METRIC_SENTINEL;
  });
  doubles[AE_DOUBLE_INTERVAL_INDEX] = intervalSeconds;
  return doubles;
}

/**
 * Pack `managed.storage`'s single fixed-shape row: the 7 flat byte totals at
 * double1..double7 followed by the 12 per-engine census readings at
 * double8..double19, filling the page exactly. A per-engine ref reads from
 * its own nested sub-object; a flat ref reads the sample itself. Host-wide
 * with no entity identity, so blob10 stays empty.
 */
function packStorageDoubles(
  storage: StorageSample,
  intervalSeconds: number,
): number[] {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  STORAGE_FIELD_ORDER.forEach((ref, i) => {
    const source = ref.group === null ? storage : storage[ref.group];
    doubles[i] = numericField(source, ref.field) ?? AE_MISSING_METRIC_SENTINEL;
  });
  doubles[AE_DOUBLE_INTERVAL_INDEX] = intervalSeconds;
  return doubles;
}

/**
 * Pack `managed.docker`'s single fixed-shape row — Docker's own
 * `GET /system/df` breakdown. Flat, so it reuses {@link packSingleEntityRow}
 * the way {@link packRouterDoubles} does; its 9 reserved spares stay sentinel
 * by the same rule.
 */
function packDockerUsageDoubles(
  dockerUsage: DockerUsageSample,
  intervalSeconds: number,
): number[] {
  return packSingleEntityRow(
    dockerUsage,
    DOCKER_USAGE_FIELD_ORDER,
    intervalSeconds,
  );
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

function capabilityPlanGenerationBlob(
  sample: MetricsSample & { capabilityPlanGeneration?: number },
): string {
  return sample.capabilityPlanGeneration === undefined
    ? ""
    : String(sample.capabilityPlanGeneration);
}

/** Shared envelope for a `"metrics"`-kind row. `sourceOrIdentity` is blob10 — see its index doc comment. */
export function buildMetricsBlobs(
  sample: MetricsSample & { capabilityPlanGeneration?: number },
  family: HostedFamily,
  page: number,
  sourceOrIdentity: string,
): string[] {
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_KIND_INDEX] = AE_KIND_METRICS;
  blobs[AE_BLOB_FAMILY_INDEX] = family;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(sample.metadata.version);
  blobs[AE_BLOB_SAMPLED_AT_INDEX] = sample.metadata.sampledAt;
  blobs[AE_BLOB_SEQUENCE_INDEX] = String(sample.metadata.sequence);
  blobs[AE_BLOB_TOPOLOGY_GENERATION_INDEX] = String(
    sample.metadata.topologyGeneration,
  );
  blobs[AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX] =
    capabilityPlanGenerationBlob(sample);
  blobs[AE_BLOB_PAGE_INDEX] = String(page);
  blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX] = sourceOrIdentity;
  return blobs;
}

/** Envelope for a `"event"`-kind row — one per `sample.events` entry. */
export function buildEventBlobs(
  sample: MetricsSample & { capabilityPlanGeneration?: number },
  event: MetricEvent,
): string[] {
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_KIND_INDEX] = AE_KIND_EVENT;
  blobs[AE_BLOB_FAMILY_INDEX] = event.kind;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(sample.metadata.version);
  blobs[AE_BLOB_SAMPLED_AT_INDEX] = event.at;
  blobs[AE_BLOB_SEQUENCE_INDEX] = String(sample.metadata.sequence);
  blobs[AE_BLOB_TOPOLOGY_GENERATION_INDEX] = String(
    sample.metadata.topologyGeneration,
  );
  blobs[AE_BLOB_CAPABILITY_PLAN_GENERATION_INDEX] =
    capabilityPlanGenerationBlob(sample);
  blobs[AE_BLOB_PAGE_INDEX] = "0";
  blobs[AE_BLOB_SOURCE_OR_IDENTITY_INDEX] = event.source ?? "";
  blobs[AE_BLOB_EVENT_ENTITY_ID_INDEX] = event.entityId ?? "";
  blobs[AE_BLOB_EVENT_PAYLOAD_INDEX] = JSON.stringify(event.payload ?? {});
  blobs[AE_BLOB_EVENT_ID_INDEX] = event.eventId;
  blobs[AE_BLOB_STATUS_OR_EVENT_REASON_INDEX] = event.severity;
  return blobs;
}

/** Envelope for a `"status"`-kind row — connection-status transitions. */
export function buildStatusBlobs(event: ServerStatusEvent): string[] {
  const blobs: string[] = new Array(AE_BLOB_COUNT).fill("");
  blobs[AE_BLOB_KIND_INDEX] = AE_KIND_STATUS;
  blobs[AE_BLOB_SCHEMA_VERSION_INDEX] = String(METRICS_SCHEMA_VERSION);
  blobs[AE_BLOB_STATUS_OR_EVENT_REASON_INDEX] = event.reason;
  return blobs;
}

/** Build the AE v5 data point for a connection-status transition. */
export function buildStatusDataPoint(
  event: ServerStatusEvent,
): AnalyticsEngineDataPointLike {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  doubles[AE_DOUBLE_STATUS_CONNECTED_INDEX] = event.connected ? 1 : 0;

  const point: AnalyticsEngineDataPointLike = {
    indexes: [event.serverId],
    doubles,
    blobs: buildStatusBlobs(event),
  };
  assertAnalyticsEngineDataPointShape(point);
  return point;
}

function buildEventDataPoint(
  sample: AuthenticatedMetricsSample,
  event: MetricEvent,
): AnalyticsEngineDataPointLike {
  const doubles = new Array<number>(AE_DOUBLE_COUNT).fill(
    AE_MISSING_METRIC_SENTINEL,
  );
  // Event rows carry the interval weight like every other `"metrics"`-shaped
  // row. v4 left this slot at the sentinel, contradicting its own documented
  // invariant; the row-count test asserted the invariant but no fixture
  // carried an event, so it never fired.
  doubles[AE_DOUBLE_INTERVAL_INDEX] = sample.metadata.intervalSeconds;
  const point: AnalyticsEngineDataPointLike = {
    indexes: [sample.serverId],
    doubles,
    blobs: buildEventBlobs(sample, event),
  };
  assertAnalyticsEngineDataPointShape(point);
  return point;
}

/**
 * Build every AE v5 data point for one authenticated v5 sample.
 *
 * `host.system` and `host.io` are always emitted (one row each, even if
 * every metric in them is missing — mirroring v3's mandatory-part
 * discipline). `gpu`/`network`/`filesystem`/`block`/`hardware.physical` are
 * presence-gated: paged rows are emitted only when their source array is
 * non-empty. `managed.ingress` / `managed.database_proxy` emit one unpaged
 * row per array entry. `host.diagnostics` is presence-gated (emitted
 * whenever `sample.diagnostics` is present — v6 no longer gates it on a
 * capability, so in practice every Linux host reports it). `events` emits one
 * `"event"`-kind row per entry. `managed.storage` and `managed.docker` are
 * presence-gated too: the first is ungated by the capability plan but still
 * absent until the daemon's directory-usage walker has a result, and the
 * second is dropped at ingest when `managedDockerEnabled` is off. Order is
 * deterministic: host.system, host.io, gpu, network, filesystem, block,
 * hardware.physical, managed.ingress, managed.database_proxy, managed.router,
 * managed.storage, managed.docker, host.diagnostics, event.
 *
 * `slotMapping` — resolved by the caller from the sample's own
 * `metadata.topologyGeneration` (see `types.ts`'s
 * `ServerMetricsStore.writeSample` doc comment) — drives identity-addressed
 * packing for `host.io`'s embedded NICs and every paged family's entity
 * order; see the module doc comment for exact behavior with and without it.
 */
export function buildMetricsDataPoints(
  sample: AuthenticatedMetricsSample,
  slotMapping?: SlotMapping,
): AnalyticsEngineDataPointLike[] {
  const points: AnalyticsEngineDataPointLike[] = [];
  const interval = sample.metadata.intervalSeconds;

  const pushMetricsPoint = (
    family: HostedFamily,
    page: number,
    sourceOrIdentity: string,
    doubles: number[],
  ): void => {
    const point: AnalyticsEngineDataPointLike = {
      indexes: [sample.serverId],
      doubles,
      blobs: buildMetricsBlobs(sample, family, page, sourceOrIdentity),
    };
    assertAnalyticsEngineDataPointShape(point);
    points.push(point);
  };

  const { nic0, nic1, paged: pagedNetworks } = resolveNetworkSlots(
    sample.networks,
    slotMapping,
  );

  pushMetricsPoint(AE_FAMILY_HOST_SYSTEM, 0, "", packHostSystemDoubles(sample));
  pushMetricsPoint(
    AE_FAMILY_HOST_IO,
    0,
    "",
    packHostIoDoubles(sample, nic0, nic1),
  );

  const orderedGpus = orderByPageOrder(
    sample.gpus,
    (gpu) => gpu.gpuId,
    slotMapping?.gpuPageOrder,
  );
  for (
    const { doubles, page, ids } of packEntityPages(
      orderedGpus,
      GPU_FIELD_ORDER,
      GPU_FIELD_ORDER.length,
      interval,
      (gpu) => gpu.gpuId,
    )
  ) {
    pushMetricsPoint(AE_FAMILY_GPU, page, ids, doubles);
  }

  for (
    const { doubles, page, ids } of packEntityPages(
      pagedNetworks,
      NETWORK_FIELD_ORDER,
      NETWORK_FIELD_ORDER.length,
      interval,
      (device) => device.deviceId,
    )
  ) {
    pushMetricsPoint(AE_FAMILY_NETWORK, page, ids, doubles);
  }

  const orderedFilesystems = orderByPageOrder(
    sample.filesystems,
    (fs) => fs.filesystemId,
    slotMapping?.filesystemPageOrder,
  );
  for (
    const { doubles, page, ids } of packEntityPages(
      orderedFilesystems,
      FILESYSTEM_FIELD_ORDER,
      FILESYSTEM_FIELD_ORDER.length,
      interval,
      (fs) => fs.filesystemId,
    )
  ) {
    pushMetricsPoint(AE_FAMILY_FILESYSTEM, page, ids, doubles);
  }

  const orderedBlockDevices = orderByPageOrder(
    sample.blockDevices,
    (device) => device.deviceId,
    slotMapping?.blockPageOrder,
  );
  for (
    const { doubles, page, ids } of packEntityPages(
      orderedBlockDevices,
      BLOCK_FIELD_ORDER,
      BLOCK_FIELD_ORDER.length,
      interval,
      (device) => device.deviceId,
    )
  ) {
    pushMetricsPoint(AE_FAMILY_BLOCK, page, ids, doubles);
  }

  const orderedHardwareSignals = orderByPageOrder(
    sample.hardwareSignals,
    (signal) => signal.signalId,
    slotMapping?.hardwareSignalPageOrder,
  );
  for (
    const { doubles, page, ids } of packEntityPages(
      orderedHardwareSignals,
      HARDWARE_SIGNAL_FIELD_ORDER,
      HARDWARE_SIGNAL_FIELD_ORDER.length,
      interval,
      (signal) => signal.signalId,
    )
  ) {
    pushMetricsPoint(AE_FAMILY_HARDWARE_PHYSICAL, page, ids, doubles);
  }

  for (const ingress of sample.ingressSources) {
    pushMetricsPoint(
      AE_FAMILY_MANAGED_INGRESS,
      0,
      ingress.sourceId,
      packSingleEntityRow(ingress, INGRESS_FIELD_ORDER, interval),
    );
  }

  for (const proxy of sample.databaseProxies) {
    pushMetricsPoint(
      AE_FAMILY_MANAGED_DATABASE_PROXY,
      0,
      proxy.sourceId,
      packSingleEntityRow(proxy, DATABASE_PROXY_FIELD_ORDER, interval),
    );
  }

  if (sample.router) {
    pushMetricsPoint(
      AE_FAMILY_MANAGED_ROUTER,
      0,
      "",
      packRouterDoubles(sample.router, interval),
    );
  }

  if (sample.storage) {
    pushMetricsPoint(
      AE_FAMILY_MANAGED_STORAGE,
      0,
      "",
      packStorageDoubles(sample.storage, interval),
    );
  }

  if (sample.dockerUsage) {
    pushMetricsPoint(
      AE_FAMILY_MANAGED_DOCKER,
      0,
      "",
      packDockerUsageDoubles(sample.dockerUsage, interval),
    );
  }

  if (sample.diagnostics) {
    pushMetricsPoint(
      AE_FAMILY_HOST_DIAGNOSTICS,
      0,
      "",
      packDiagnosticsDoubles(sample.diagnostics, interval),
    );
  }

  for (const event of sample.events) {
    points.push(buildEventDataPoint(sample, event));
  }

  return capToInvocationLimit(points, sample.serverId);
}

/**
 * Analytics Engine accepts at most this many data points per Worker
 * invocation. A metrics sample is written as one invocation, so this is a
 * hard ceiling on rows per sample, not a soft budget.
 *
 * https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
export const AE_MAX_DATA_POINTS_PER_INVOCATION = 250;

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
function invocationPriority(point: AnalyticsEngineDataPointLike): number {
  const kind = point.blobs?.[AE_BLOB_KIND_INDEX];
  if (kind === AE_KIND_METRICS) {
    const family = point.blobs?.[AE_BLOB_FAMILY_INDEX];
    if (family === AE_FAMILY_HOST_SYSTEM || family === AE_FAMILY_HOST_IO) {
      return 0;
    }
    return 2;
  }
  if (kind === AE_KIND_EVENT) return 1;
  return 2;
}

/**
 * Enforce {@link AE_MAX_DATA_POINTS_PER_INVOCATION}.
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
function capToInvocationLimit(
  points: AnalyticsEngineDataPointLike[],
  serverId: string,
): AnalyticsEngineDataPointLike[] {
  if (points.length <= AE_MAX_DATA_POINTS_PER_INVOCATION) return points;
  const ordered = points
    .map((point, index) => ({
      point,
      index,
      priority: invocationPriority(point),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, AE_MAX_DATA_POINTS_PER_INVOCATION)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.point);
  console.warn(
    `metrics: sample for ${serverId} produced ${points.length} Analytics Engine data points, ` +
      `over the ${AE_MAX_DATA_POINTS_PER_INVOCATION}-per-invocation limit; ` +
      `dropped ${points.length - ordered.length} lowest-priority rows`,
  );
  return ordered;
}

// ---------------------------------------------------------------------------
// Module-load invariants
// ---------------------------------------------------------------------------

/**
 * Every descriptor whose `entityScope` is `scope`, keyed by `fieldName`. Used
 * to verify a hand-declared field-order array is exactly the descriptor set
 * for that scope — no missing field, no unknown field, no duplicate.
 *
 * Deliberately does not import `metric-descriptors.ts`'s private
 * `_internal.PER_ENTITY_CAPACITY` / `HOSTED_FAMILY_CAPACITY` (that
 * object is exposed for that module's own tests, not as a public API this
 * module should depend on) — this derives the equivalent guarantee from the
 * public `HOST_METRICS_METRIC_DESCRIPTORS` map plus the physical
 * `AE_METRIC_DOUBLE_SLOT_COUNT` page-size constant instead.
 */
function descriptorsForScope(
  scope: MetricEntityScope,
): HostMetricsMetricDescriptor[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS).filter(
    (descriptor) => descriptor.entityScope === scope,
  );
}

function assertFieldOrderMatchesDescriptors(
  label: string,
  scope: MetricEntityScope,
  fields: readonly string[],
): void {
  const expected = new Set(
    descriptorsForScope(scope).map((descriptor) => descriptor.fieldName),
  );
  const actual = new Set(fields);
  if (actual.size !== fields.length) {
    throw new TypeError(`${label} field order has duplicate entries`);
  }
  for (const field of fields) {
    if (!expected.has(field)) {
      throw new TypeError(
        `${label} field order lists unknown field: ${scope}.${field}`,
      );
    }
  }
  for (const field of expected) {
    if (!actual.has(field)) {
      throw new TypeError(
        `${label} field order is missing descriptor field: ${scope}.${field}`,
      );
    }
  }
}

function assertWithinPageBudget(label: string, width: number): void {
  if (width > AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `${label} has ${width} fields, exceeding the ${AE_METRIC_DOUBLE_SLOT_COUNT}-slot AE page budget`,
    );
  }
}

function assertFieldOrderInvariants(): void {
  if (AE_DOUBLE_INTERVAL_INDEX !== 19) {
    throw new TypeError("AE_DOUBLE_INTERVAL_INDEX must be 19 (double20)");
  }

  assertFieldOrderMatchesDescriptors(
    "host.cpu",
    "host.cpu",
    HOST_CPU_FIELD_ORDER,
  );
  assertFieldOrderMatchesDescriptors(
    "host.memory",
    "host.memory",
    HOST_MEMORY_FIELD_ORDER,
  );
  if (HOST_SYSTEM_FIELD_ORDER.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `host.system field order has ${HOST_SYSTEM_FIELD_ORDER.length} fields, expected exactly ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }

  assertFieldOrderMatchesDescriptors(
    "host.kernel",
    "host.kernel",
    HOST_KERNEL_FIELD_ORDER,
  );
  assertFieldOrderMatchesDescriptors(
    "host.storage",
    "host.storage",
    HOST_STORAGE_FIELD_ORDER,
  );
  assertFieldOrderMatchesDescriptors(
    "host.network",
    "host.network",
    HOST_NETWORK_FIELD_ORDER,
  );
  // `HOST_IO_FIELD_ORDER` carries reserved spare slots between groups, so its
  // length is a slot count, not a field count — the per-scope checks above are
  // what pin the fields themselves.
  const hostIoTotalSlots = HOST_IO_FIELD_ORDER.length +
    HOST_IO_NIC_EMBED_SLOT_COUNT;
  if (hostIoTotalSlots > AE_DOUBLE_INTERVAL_INDEX) {
    throw new TypeError(
      `host.io consumes ${hostIoTotalSlots} slots, colliding with the reserved interval slot (double20)`,
    );
  }

  assertFieldOrderMatchesDescriptors("gpu", "gpu", GPU_FIELD_ORDER);
  assertFieldOrderMatchesDescriptors("network", "network", NETWORK_FIELD_ORDER);
  assertFieldOrderMatchesDescriptors(
    "filesystem",
    "filesystem",
    FILESYSTEM_FIELD_ORDER,
  );
  assertFieldOrderMatchesDescriptors("block", "block", BLOCK_FIELD_ORDER);
  assertFieldOrderMatchesDescriptors(
    "hardwareSignal",
    "hardwareSignal",
    HARDWARE_SIGNAL_FIELD_ORDER,
  );
  assertWithinPageBudget("gpu per-entity width", GPU_FIELD_ORDER.length);
  assertWithinPageBudget(
    "network per-entity width",
    NETWORK_FIELD_ORDER.length,
  );
  assertWithinPageBudget(
    "filesystem per-entity width",
    FILESYSTEM_FIELD_ORDER.length,
  );
  assertWithinPageBudget("block per-entity width", BLOCK_FIELD_ORDER.length);

  // The three single-row families carry reserved spare slots, so their array
  // length is a slot count and only the non-spare entries are compared
  // against the descriptor set.
  assertFieldOrderMatchesDescriptors(
    "ingress",
    "ingress",
    declaredFields(INGRESS_FIELD_ORDER),
  );
  assertFieldOrderMatchesDescriptors(
    "databaseProxy",
    "databaseProxy",
    declaredFields(DATABASE_PROXY_FIELD_ORDER),
  );
  assertFieldOrderMatchesDescriptors(
    "router",
    "router",
    declaredFields(ROUTER_FIELD_ORDER),
  );
  assertFieldOrderMatchesDescriptors(
    "storage",
    "storage",
    STORAGE_SLOT_FIELD_NAMES,
  );
  assertFieldOrderMatchesDescriptors(
    "dockerUsage",
    "dockerUsage",
    declaredFields(DOCKER_USAGE_FIELD_ORDER),
  );
  assertWithinPageBudget("managed.ingress", INGRESS_FIELD_ORDER.length);
  assertWithinPageBudget(
    "managed.database_proxy",
    DATABASE_PROXY_FIELD_ORDER.length,
  );
  assertWithinPageBudget("managed.router", ROUTER_FIELD_ORDER.length);
  // `managed.router` is a fixed-shape single row whose spares are declared
  // up front, so its slot array must span the page exactly — a field added
  // without consuming a spare fails at import rather than silently landing on
  // the reserved interval slot (same strictness as `host.diagnostics` below).
  if (ROUTER_FIELD_ORDER.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `managed.router field order has ${ROUTER_FIELD_ORDER.length} slots, expected exactly ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }

  // The two v6 host-wide storage families are fixed-shape single rows whose
  // spares (nine on `managed.docker`, none on `managed.storage`) are declared
  // up front, so each slot array must span the page exactly — the same
  // strictness `managed.router` and `host.diagnostics` carry.
  assertWithinPageBudget("managed.storage", STORAGE_FIELD_ORDER.length);
  assertWithinPageBudget("managed.docker", DOCKER_USAGE_FIELD_ORDER.length);
  if (STORAGE_FIELD_ORDER.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `managed.storage field order has ${STORAGE_FIELD_ORDER.length} slots, expected exactly ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }
  if (DOCKER_USAGE_FIELD_ORDER.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `managed.docker field order has ${DOCKER_USAGE_FIELD_ORDER.length} slots, expected exactly ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }
  if (
    STORAGE_SLOT_FIELD_NAMES.length !== new Set(STORAGE_SLOT_FIELD_NAMES).size
  ) {
    throw new TypeError(
      "managed.storage field order has duplicate flattened field names",
    );
  }
  if (
    DOCKER_USAGE_FIELD_NAMES.length !==
      declaredFields(DOCKER_USAGE_FIELD_ORDER).length
  ) {
    throw new TypeError(
      "managed.docker field order does not declare every DockerUsageSample descriptor field",
    );
  }

  assertFieldOrderMatchesDescriptors(
    "diagnostics",
    "diagnostics",
    DIAGNOSTICS_FIELD_NAMES,
  );
  // The merged family fills its page exactly (7 CPU + 12 memory). The
  // assertion stays strict (`!==`, not `>`) so a field added on either half
  // without a matching drop elsewhere fails at import rather than silently
  // landing on the reserved interval slot.
  if (DIAGNOSTICS_FIELD_ORDER.length !== AE_METRIC_DOUBLE_SLOT_COUNT) {
    throw new TypeError(
      `host.diagnostics field order has ${DIAGNOSTICS_FIELD_ORDER.length} fields, expected exactly ${AE_METRIC_DOUBLE_SLOT_COUNT}`,
    );
  }
}
assertFieldOrderInvariants();

/** Exposed for tests that need to exercise the throw behavior without waiting on module-load side effects. */
export const _internalFieldMap = {
  assertFieldOrderMatchesDescriptors,
  assertWithinPageBudget,
  entitiesPerPage,
};

// ---------------------------------------------------------------------------
// Query-side lookups — the read path (`sql-api.ts`) resolves a requested
// canonical/field name to its physical AE double slot through these, so the
// field ordering declared above stays this module's only copy.
// ---------------------------------------------------------------------------

export { entitiesPerPage };

/** Per-entity-family field order + width, keyed by `HostedFamily`. */
export const PER_ENTITY_FIELD_ORDER: Record<
  Extract<
    HostedFamily,
    "gpu" | "network" | "filesystem" | "block" | "hardware.physical"
  >,
  readonly string[]
> = {
  gpu: GPU_FIELD_ORDER,
  network: NETWORK_FIELD_ORDER,
  filesystem: FILESYSTEM_FIELD_ORDER,
  block: BLOCK_FIELD_ORDER,
  "hardware.physical": HARDWARE_SIGNAL_FIELD_ORDER,
};

/**
 * The only `network`-family fields individually reconstructable from
 * `host.io`'s embedded NIC slots — receive/transmit bytes-per-second embed
 * verbatim (see `packHostIoDoubles`), but the 4 error/drop rates are only
 * ever embedded pre-summed as one combined problem-packets rate, with no way
 * to recover the individual components. Exported so the query layer
 * (`sql-api.ts`) knows exactly which requested `network` fields it can
 * answer for a topology's slot-mapped NICs — every other requested field
 * resolves to `null` for those two entities, never a fabricated split of the
 * combined rate.
 */
export const HOST_IO_EMBEDDED_NIC_FIELDS = [
  "receiveBytesPerSecond",
  "transmitBytesPerSecond",
] as const;

/**
 * 0-based `host.io` double index for slot-mapped NIC `slot` (`0` =
 * `SlotMapping.normalNicSlots[0]`, `1` = `normalNicSlots[1]`)'s `field` — one of
 * {@link HOST_IO_EMBEDDED_NIC_FIELDS}. Mirrors `packHostIoDoubles`'s embed
 * layout (`embedBase + slot * 3` for receive, `+ 1` for transmit; `+ 2` is
 * the combined problem-packets rate, not individually addressable here);
 * `embedBase` is `HOST_IO_FIELD_ORDER.length`, 13 in v6.
 * Used by the read path to reconstruct a queryable `network` entity series
 * for a topology's slot-mapped NICs, which never page as standalone
 * `network` rows on this backend (see the module doc comment).
 */
export function hostIoEmbeddedNicDoubleIndex(
  slot: 0 | 1,
  field: (typeof HOST_IO_EMBEDDED_NIC_FIELDS)[number],
): number {
  const embedBase = HOST_IO_FIELD_ORDER.length;
  const slotBase = embedBase + slot * 3;
  return field === "receiveBytesPerSecond" ? slotBase : slotBase + 1;
}

/**
 * Single-row-per-entity family slot order (`managed.ingress` /
 * `managed.database_proxy` — no paging). A `null` entry is a reserved spare,
 * so a field's index in this array is its physical double index; the read
 * path resolves by `indexOf`, which skips spares for free.
 */
export const SINGLE_ROW_FIELD_ORDER: Record<
  Extract<HostedFamily, "managed.ingress" | "managed.database_proxy">,
  readonly (string | null)[]
> = {
  "managed.ingress": INGRESS_FIELD_ORDER,
  "managed.database_proxy": DATABASE_PROXY_FIELD_ORDER,
};

/**
 * Resolve a fixed-shape-family-scoped field to its physical AE double slot:
 * which single-row family carries it (`host.system` / `host.io` /
 * `host.diagnostics`) and its 0-based double index. v6 removed `host.io`'s
 * overflow block — every host field now sits on the row its own
 * `hostedFamily` names — and merged the two detail families into
 * `host.diagnostics` (scope `diagnostics`), whose 7 CPU scalars occupy
 * double1..double7 ahead of its 12 memory fields. Throws for any scope/field
 * this module doesn't pack as a fixed single-row double slot (per-entity
 * families, or an unknown field).
 */
export function doubleIndexForHostField(
  scope: MetricEntityScope,
  field: string,
): {
  family: Extract<
    HostedFamily,
    | "host.system"
    | "host.io"
    | "host.diagnostics"
    | "managed.router"
    | "managed.storage"
    | "managed.docker"
  >;
  doubleIndex: number;
} {
  const systemIndex = HOST_SYSTEM_FIELD_ORDER.findIndex(
    (ref) => ref.scope === scope && ref.field === field,
  );
  if (systemIndex !== -1) {
    return { family: "host.system", doubleIndex: systemIndex };
  }
  // Spare slots are `null` and match nothing, so a hit's array position is
  // already the physical double index.
  const ioIndex = HOST_IO_FIELD_ORDER.findIndex(
    (ref) => ref?.scope === scope && ref.field === field,
  );
  if (ioIndex !== -1) {
    return { family: "host.io", doubleIndex: ioIndex };
  }
  if (scope === "diagnostics") {
    const diagnosticsIndex = DIAGNOSTICS_FIELD_NAMES.indexOf(field);
    if (diagnosticsIndex !== -1) {
      return { family: "host.diagnostics", doubleIndex: diagnosticsIndex };
    }
  }
  // `managed.router` resolves here rather than through
  // `SINGLE_ROW_FIELD_ORDER`: that map is `sourceId`-keyed (one row per
  // entity), while the router is host-wide and singleton — the same shape
  // `host.diagnostics` has. Spares are `null` and match nothing, so a hit's
  // array position is already the physical double index.
  if (scope === "router") {
    const routerIndex = ROUTER_FIELD_ORDER.indexOf(field);
    if (routerIndex !== -1) {
      return { family: "managed.router", doubleIndex: routerIndex };
    }
  }
  // `managed.storage` / `managed.docker` resolve here for the same reason
  // `managed.router` does: both are host-wide singletons with no `sourceId`.
  // Storage's slot names are already flattened (`postgresInstancesRunning`),
  // so its array position is the physical double index directly; docker's
  // spares are `null` and match nothing.
  if (scope === "storage") {
    const storageIndex = STORAGE_SLOT_FIELD_NAMES.indexOf(field);
    if (storageIndex !== -1) {
      return { family: "managed.storage", doubleIndex: storageIndex };
    }
  }
  if (scope === "dockerUsage") {
    const dockerIndex = DOCKER_USAGE_FIELD_ORDER.indexOf(field);
    if (dockerIndex !== -1) {
      return { family: "managed.docker", doubleIndex: dockerIndex };
    }
  }
  throw new TypeError(
    `no AE v6 host double slot for field "${scope}.${field}"`,
  );
}

/**
 * 0-based double index for entity `slotPosition` (0-based, within a page of
 * `width`-wide entities) and `fieldIndex` (0-based, within that family's
 * field order). Callers must check `slotPosition < entitiesPerPage(width)`
 * themselves — this does not re-validate the page budget.
 */
export function slotDoubleIndex(
  width: number,
  slotPosition: number,
  fieldIndex: number,
): number {
  return slotPosition * width + fieldIndex;
}
