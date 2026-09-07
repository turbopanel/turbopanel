/**
 * Pure helpers for server metrics routes — query parsing, backend kind, and
 * response shaping without a Hono Context.
 */

import { CloudflareAnalyticsEngineServerMetricsStoreV5 } from '../../daemon/metrics/backends/cloudflare/store-v5.ts'
import { DisabledServerMetricsStoreV5 } from '../../daemon/metrics/disabled-store-v5.ts'
import type {
  EntitySeriesResultV5,
  HostSeriesResultV5,
  MetricEventsResultV5,
  MetricsBackendKind,
  PerEntityHostedFamilyV5,
  ServerMetricsStoreV5,
  StatusHistoryResult,
} from '../../daemon/metrics/types-v5.ts'
import {
  HOST_METRICS_METRIC_DESCRIPTORS_V5,
  type MetricEntityScopeV5,
} from '../../daemon/metrics/metric-descriptors-v5.ts'
import {
  type EntityMetricSelector,
  parseEntityMetricId,
} from '../../daemon/metrics/entity-metric-id.ts'
import {
  computeDerivedHostValuesV5,
  type DerivedHostValuesV5,
  type HostCapacitiesV5,
} from '../../daemon/metrics/query/derived-metrics-v5.ts'
import type { HostSeriesChartResponseV5 } from '../../daemon/metrics/query/series-response-v5.ts'
import { computeSlotMapping } from './topology-slot-mapping.ts'
import {
  buildTopologyInventoryV5,
  rootFilesystemTotalBytesV5,
  type TopologyInventoryV5,
} from './topology-inventory.ts'
import type { AuthRouteOpts } from '../authn/http.ts'
import {
  inferServerMachineClass,
  type ServerMachineClass,
} from '../../daemon/metrics/capability-plan.ts'
import {
  type EffectiveCpuThermalLimits,
  HARDWARE_PROFILE_NIC_KEYS,
  HARDWARE_PROFILE_NIC_SLOT_LIST_KEY,
  HARDWARE_PROFILE_SENSOR_SLOT_KEYS,
  HARDWARE_PROFILE_TOPOLOGY_ID_KEYS,
  resolveEffectiveCpuThermalLimits,
  type ServerHardwareProfile,
  type ServerHardwareProfileUpdate,
  type ServerSensorSlotAssignment,
} from '../../lib/db/server-metadata.ts'
import {
  EMPTY_TOPOLOGY_OVERRIDES,
  type FilesystemId,
  MAX_NIC_SLOTS,
  type SlotMapping,
  type TopologyDeviceId,
  type TopologyOverrides,
  type TopologySnapshot,
} from './topology-types.ts'
import {
  type OrganizationOptions,
  resolveTemperatureUnit,
  type TemperatureUnit,
} from '../../lib/organization-options.ts'

export type IsoTimestampParseResult =
  | { ok: true; ms: number; iso: string }
  | {
      ok: false
      message: string
    }

/** Max characters accepted for one hardware-profile chip/label/NIC/path value. */
export const MAX_HARDWARE_PROFILE_FIELD_CHARS = 512

export type HardwareProfileBodyParse =
  | {
      ok: true
      update: ServerHardwareProfileUpdate
    }
  | { ok: false; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type SlotFieldParse =
  | { ok: true; value: ServerSensorSlotAssignment | null }
  | {
      ok: false
      message: string
    }

/** One sensor-slot field: `null` unassigns, `{chip,label}` pins an identity. */
function parseSlotField(key: string, value: unknown): SlotFieldParse {
  if (value === null) return { ok: true, value: null }
  if (!isRecord(value)) {
    return {
      ok: false,
      message: `${key} must be an object with chip/label, or null`,
    }
  }
  const chip = typeof value.chip === 'string' ? value.chip.trim() : ''
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (!chip || !label) {
    return { ok: false, message: `${key} requires non-empty chip and label` }
  }
  if (
    chip.length > MAX_HARDWARE_PROFILE_FIELD_CHARS ||
    label.length > MAX_HARDWARE_PROFILE_FIELD_CHARS
  ) {
    return { ok: false, message: `${key} chip/label exceeds max length` }
  }
  return { ok: true, value: { chip, label } }
}

type OptionalStringFieldParse =
  | { ok: true; value: string | null }
  | {
      ok: false
      message: string
    }

/**
 * One NIC-binding or topology-id field: `null` unassigns, a non-blank string
 * names the interface / pins the opaque device or filesystem id.
 */
function parseOptionalStringField(key: string, value: unknown): OptionalStringFieldParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return { ok: false, message: `${key} must be a string or null` }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: `${key} must not be blank` }
  }
  if (trimmed.length > MAX_HARDWARE_PROFILE_FIELD_CHARS) {
    return { ok: false, message: `${key} exceeds max length` }
  }
  return { ok: true, value: trimmed }
}

const KNOWN_HARDWARE_PROFILE_KEYS = new Set<string>([
  ...HARDWARE_PROFILE_SENSOR_SLOT_KEYS,
  ...HARDWARE_PROFILE_NIC_KEYS,
  ...HARDWARE_PROFILE_TOPOLOGY_ID_KEYS,
  HARDWARE_PROFILE_NIC_SLOT_LIST_KEY,
  'hostingPath',
  'drivetempEnabled',
  'cpuTdpWattsOverride',
  'cpuTjMaxCelsiusOverride',
])

/** Generous ceiling — well above any real single-socket CPU's TDP. */
const CPU_TDP_WATTS_MAX = 1000
/** Plausible silicon junction-temperature range. */
const CPU_TJ_MAX_CELSIUS_MIN = 40
const CPU_TJ_MAX_CELSIUS_MAX = 130

type NumberFieldParse =
  | { ok: true; value: number | null }
  | {
      ok: false
      message: string
    }

/** `cpuTdpWattsOverride`: `null` clears it, a finite positive number under the ceiling pins it. */
function parseCpuTdpWattsField(value: unknown): NumberFieldParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      message: 'cpuTdpWattsOverride must be a finite number or null',
    }
  }
  if (value <= 0 || value > CPU_TDP_WATTS_MAX) {
    return {
      ok: false,
      message: `cpuTdpWattsOverride must be greater than 0 and at most ${CPU_TDP_WATTS_MAX}`,
    }
  }
  return { ok: true, value }
}

/** `cpuTjMaxCelsiusOverride`: `null` clears it, a value within the plausible silicon range pins it. */
function parseCpuTjMaxCelsiusField(value: unknown): NumberFieldParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      ok: false,
      message: 'cpuTjMaxCelsiusOverride must be a finite number or null',
    }
  }
  if (value < CPU_TJ_MAX_CELSIUS_MIN || value > CPU_TJ_MAX_CELSIUS_MAX) {
    return {
      ok: false,
      message: `cpuTjMaxCelsiusOverride must be between ${CPU_TJ_MAX_CELSIUS_MIN} and ${CPU_TJ_MAX_CELSIUS_MAX}`,
    }
  }
  return { ok: true, value }
}

type HardwareProfileFieldResult = { ok: true } | { ok: false; message: string }

type NicSlotListParse =
  | { ok: true; value: string[] | null }
  | {
      ok: false
      message: string
    }

/**
 * `nicSlotDeviceIds`: `null` returns the server to auto selection; an array
 * is the complete monitored-NIC list in slot order — every entry a non-blank
 * opaque topology device id, deduplicated, at most `MAX_NIC_SLOTS` (the
 * effective plan's smaller `normalNicSlots` limit is checked by the route
 * once it has resolved that plan).
 */
function parseNicSlotListField(value: unknown): NicSlotListParse {
  if (value === null) return { ok: true, value: null }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      message: `${HARDWARE_PROFILE_NIC_SLOT_LIST_KEY} must be an array of topology device ids or null`,
    }
  }
  const ids: string[] = []
  for (const entry of value) {
    if (entry === null) {
      return {
        ok: false,
        message: `${HARDWARE_PROFILE_NIC_SLOT_LIST_KEY} entries must be non-blank strings`,
      }
    }
    const parsed = parseOptionalStringField(HARDWARE_PROFILE_NIC_SLOT_LIST_KEY, entry)
    if (!parsed.ok) return parsed
    if (parsed.value !== null && !ids.includes(parsed.value)) {
      ids.push(parsed.value)
    }
  }
  if (ids.length > MAX_NIC_SLOTS) {
    return {
      ok: false,
      message: `${HARDWARE_PROFILE_NIC_SLOT_LIST_KEY} accepts at most ${MAX_NIC_SLOTS} devices`,
    }
  }
  return { ok: true, value: ids }
}

/** Rejects any key not in {@link KNOWN_HARDWARE_PROFILE_KEYS} so a typo cannot silently no-op. */
function findUnknownHardwareProfileField(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (!KNOWN_HARDWARE_PROFILE_KEYS.has(key)) return key
  }
  return null
}

function applySensorSlotFields(
  body: Record<string, unknown>,
  update: ServerHardwareProfileUpdate
): HardwareProfileFieldResult {
  for (const key of HARDWARE_PROFILE_SENSOR_SLOT_KEYS) {
    const value = body[key]
    if (value === undefined) continue
    const parsed = parseSlotField(key, value)
    if (!parsed.ok) return parsed
    update[key] = parsed.value
  }
  return { ok: true }
}

type OptionalStringProfileKey =
  (typeof HARDWARE_PROFILE_NIC_KEYS)[number] | (typeof HARDWARE_PROFILE_TOPOLOGY_ID_KEYS)[number]

function applyOptionalStringFields(
  keys: readonly OptionalStringProfileKey[],
  body: Record<string, unknown>,
  update: ServerHardwareProfileUpdate
): HardwareProfileFieldResult {
  for (const key of keys) {
    const value = body[key]
    if (value === undefined) continue
    const parsed = parseOptionalStringField(key, value)
    if (!parsed.ok) return parsed
    update[key] = parsed.value
  }
  return { ok: true }
}

type HostingPathParse =
  | { ok: true; value: string | null }
  | {
      ok: false
      message: string
    }

/** `hostingPath`: `null` clears it, an absolute path without whitespace pins it. */
function parseHostingPathField(value: unknown): HostingPathParse {
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    return { ok: false, message: 'hostingPath must be a string or null' }
  }
  if (value.length > MAX_HARDWARE_PROFILE_FIELD_CHARS) {
    return { ok: false, message: 'hostingPath exceeds max length' }
  }
  const trimmed = value.trim()
  if (trimmed.length > 0 && (!trimmed.startsWith('/') || /[\s\p{Cc}]/u.test(trimmed))) {
    return {
      ok: false,
      message: 'hostingPath must be an absolute path without whitespace',
    }
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : null }
}

type DrivetempEnabledParse =
  | { ok: true; value: boolean | null }
  | {
      ok: false
      message: string
    }

function parseDrivetempEnabledField(value: unknown): DrivetempEnabledParse {
  if (value !== null && typeof value !== 'boolean') {
    return { ok: false, message: 'drivetempEnabled must be a boolean or null' }
  }
  return { ok: true, value }
}

type SimpleUpdateKey =
  | typeof HARDWARE_PROFILE_NIC_SLOT_LIST_KEY
  | 'hostingPath'
  | 'drivetempEnabled'
  | 'cpuTdpWattsOverride'
  | 'cpuTjMaxCelsiusOverride'

/** Applies one `undefined`-skippable, independently-parsed field to `update`. */
function applyOptionalField<K extends SimpleUpdateKey>(
  value: unknown,
  key: K,
  parse: (value: unknown) =>
    | { ok: true; value: ServerHardwareProfileUpdate[K] }
    | {
        ok: false
        message: string
      },
  update: ServerHardwareProfileUpdate
): HardwareProfileFieldResult {
  if (value === undefined) return { ok: true }
  const parsed = parse(value)
  if (!parsed.ok) return parsed
  update[key] = parsed.value
  return { ok: true }
}

/**
 * Parse `PUT /servers/:id/metrics/hardware-profile`. Sensor slots accept the
 * `{chip,label}` object shape or `null`; NIC bindings and `hostingPath`
 * accept a string or `null`; `drivetempEnabled` accepts a boolean or `null`.
 * `undefined` (an absent field) leaves that setting untouched. Unknown
 * fields are rejected so a typo cannot silently no-op.
 */
export function parseHardwareProfileBody(body: unknown): HardwareProfileBodyParse {
  if (!isRecord(body)) {
    return {
      ok: false,
      message: 'expected a JSON object of hardware-profile fields',
    }
  }
  const unknownField = findUnknownHardwareProfileField(body)
  if (unknownField) {
    return {
      ok: false,
      message: `unknown hardware-profile field: ${unknownField}`,
    }
  }

  const update: ServerHardwareProfileUpdate = {}

  const slotResult = applySensorSlotFields(body, update)
  if (!slotResult.ok) return slotResult

  const nicResult = applyOptionalStringFields(HARDWARE_PROFILE_NIC_KEYS, body, update)
  if (!nicResult.ok) return nicResult

  const topologyIdResult = applyOptionalStringFields(
    HARDWARE_PROFILE_TOPOLOGY_ID_KEYS,
    body,
    update
  )
  if (!topologyIdResult.ok) return topologyIdResult

  const simpleFieldAppliers: Array<() => HardwareProfileFieldResult> = [
    () =>
      applyOptionalField(
        body[HARDWARE_PROFILE_NIC_SLOT_LIST_KEY],
        HARDWARE_PROFILE_NIC_SLOT_LIST_KEY,
        parseNicSlotListField,
        update
      ),
    () => applyOptionalField(body.hostingPath, 'hostingPath', parseHostingPathField, update),
    () =>
      applyOptionalField(
        body.drivetempEnabled,
        'drivetempEnabled',
        parseDrivetempEnabledField,
        update
      ),
    () =>
      applyOptionalField(
        body.cpuTdpWattsOverride,
        'cpuTdpWattsOverride',
        parseCpuTdpWattsField,
        update
      ),
    () =>
      applyOptionalField(
        body.cpuTjMaxCelsiusOverride,
        'cpuTjMaxCelsiusOverride',
        parseCpuTjMaxCelsiusField,
        update
      ),
  ]
  for (const applyField of simpleFieldAppliers) {
    const result = applyField()
    if (!result.ok) return result
  }

  return { ok: true, update }
}

/**
 * True when `update` assigns at least one stable topology-id override
 * (`hostingFilesystemId`, or a non-empty `nicSlotDeviceIds` list) — checked
 * against the last recorded topology generation, never a live daemon round
 * trip, so it never requires a connected daemon.
 */
export function hardwareProfileUpdateNeedsTopologyValidation(
  update: ServerHardwareProfileUpdate
): boolean {
  return (
    HARDWARE_PROFILE_TOPOLOGY_ID_KEYS.some((key) => Boolean(update[key])) ||
    (update.nicSlotDeviceIds?.length ?? 0) > 0
  )
}

/** Narrowed subset of a recorded `TopologySnapshot` used for topology-id validation. */
export type TopologyIdValidationSnapshot = Pick<TopologySnapshot, 'networks' | 'filesystems'>

/**
 * Find the first assigned topology-id override in `update` that does not
 * match a device/filesystem id in `snapshot` — the last topology generation
 * this server reported (`getLatestTopologyGeneration`,
 * `server-topology-records.ts`). Returns `null` when every assigned id is
 * valid, or when nothing was assigned.
 */
export function findInvalidTopologyIdField(
  update: ServerHardwareProfileUpdate,
  snapshot: TopologyIdValidationSnapshot | undefined
): string | null {
  const filesystemIds = new Set<FilesystemId>(
    (snapshot?.filesystems ?? []).map((fs) => fs.filesystemId)
  )
  if (update.nicSlotDeviceIds && findUnmonitorableNicSlotId(update.nicSlotDeviceIds, snapshot)) {
    return HARDWARE_PROFILE_NIC_SLOT_LIST_KEY
  }
  if (update.hostingFilesystemId && !filesystemIds.has(update.hostingFilesystemId)) {
    return 'hostingFilesystemId'
  }
  return null
}

/**
 * The first requested NIC-slot id that is not an `uplink` in the recorded
 * topology — a device the daemon never enumerated, or one it classified as a
 * bond/bridge member, a VLAN child, a tunnel, a container bridge, or
 * loopback (none of which are monitorable: their traffic is already counted
 * on an uplink, or isn't the host's). `null` when every id is an uplink.
 */
export function findUnmonitorableNicSlotId(
  nicSlotDeviceIds: readonly string[],
  snapshot: TopologyIdValidationSnapshot | undefined
): string | null {
  const uplinks = new Set<TopologyDeviceId>(
    (snapshot?.networks ?? [])
      .filter((device) => device.kind === 'uplink')
      .map((device) => device.deviceId)
  )
  return nicSlotDeviceIds.find((id) => !uplinks.has(id)) ?? null
}

/**
 * Error text when the monitored-NIC list is longer than the server's
 * effective `normalNicSlots` (its capability plan — 2 on the hosted platform
 * by default, `MAX_NIC_SLOTS` self-hosted), or `null` when it fits. Checked at
 * PUT time so a hosted operator never pins NICs that ingest would silently
 * drop.
 */
export function nicSlotLimitViolationV5(
  update: ServerHardwareProfileUpdate,
  nicSlotLimit: number
): string | null {
  const requested = update.nicSlotDeviceIds?.length ?? 0
  if (requested <= nicSlotLimit) return null
  return (
    `${HARDWARE_PROFILE_NIC_SLOT_LIST_KEY} lists ${requested} devices but this server may ` +
    `monitor at most ${nicSlotLimit}`
  )
}

/**
 * Inferred machine class from a recorded topology snapshot, with no sample
 * to fall back on — the read-side half of the shared
 * {@link inferServerMachineClass}. Routes should prefer
 * `resolveServerMachineClass` with the declared `server.machine_class`
 * column; this stays for callers that only hold a snapshot.
 */
export function machineClassFromTopologySnapshotV5(snapshot: unknown): ServerMachineClass {
  return inferServerMachineClass(snapshot)
}

export function resolveStoreBackendKindV5(
  store: ServerMetricsStoreV5 | undefined,
  runtime: AuthRouteOpts['runtime']
): MetricsBackendKind {
  if (!store) return 'disabled'
  if (store instanceof DisabledServerMetricsStoreV5) return 'disabled'
  if (store instanceof CloudflareAnalyticsEngineServerMetricsStoreV5) {
    return 'analytics-engine'
  }
  // Deno → DuckDB (or unavailable DuckDB). Workers bundles must not import the
  // native DuckDB store — runtime is the only discriminator left here.
  return runtime === 'workers' ? 'analytics-engine' : 'duckdb'
}

// ---------------------------------------------------------------------------
// v5 entity-metric selector parsing — `/servers/:id/metrics/series`'s
// `metrics` query param, one wire identity per selector
// (`entity-metric-id.ts`), grouped into a host-singleton request plus a
// per-`PerEntityHostedFamilyV5` request.
// ---------------------------------------------------------------------------

/** At most this many `metrics` selectors per `/series` request — same defensive-cap idiom as the v5 ingest entity-array caps. */
export const MAX_SERIES_METRIC_SELECTORS_V5 = 128

/** `host.*` scopes actually packed/queryable (`field-map-v5.ts` / `queryHostSeries`) — the default `metrics` selection when the query param is absent. */
const HOST_SINGLETON_QUERYABLE_SCOPES_V5: ReadonlySet<MetricEntityScopeV5> = new Set([
  'host.cpu',
  'host.kernel',
  'host.memory',
  'host.storage',
  'host.network',
])

/**
 * `cpuDetail`/`memoryDetail` are queryable singleton scopes, but capability-
 * gated and not part of the default selection — a caller must request them
 * explicitly (`cpuDetail.averageFrequencyMHz`, …), since most plans don't
 * enable them and the org servers overview shouldn't pay for columns it
 * never renders.
 */
const HOST_SINGLETON_EXPLICIT_ONLY_SCOPES_V5: ReadonlySet<MetricEntityScopeV5> = new Set([
  'cpuDetail',
  'memoryDetail',
])

/** Per-entity scope -> the `PerEntityHostedFamilyV5` its entity id/metrics are queried under. */
const ENTITY_SCOPE_TO_FAMILY_V5: Partial<Record<MetricEntityScopeV5, PerEntityHostedFamilyV5>> = {
  network: 'network',
  filesystem: 'filesystem',
  block: 'block',
  gpu: 'gpu',
  hardwareSignal: 'hardware.physical',
  ingress: 'managed.ingress',
  databaseProxy: 'managed.database_proxy',
}

/** Every queryable `host.*` canonical name — the default `metrics` selection when the query param is absent. */
export function defaultHostCanonicalNamesV5(): string[] {
  return Object.values(HOST_METRICS_METRIC_DESCRIPTORS_V5)
    .filter((descriptor) => HOST_SINGLETON_QUERYABLE_SCOPES_V5.has(descriptor.entityScope))
    .map((descriptor) => descriptor.canonicalName)
}

export type EntityFamilySelectionV5 = {
  entityIds: Set<string>
  fields: Set<string>
}

export type SeriesMetricSelectorsV5 = {
  hostCanonicalNames: string[]
  entityFamilies: Map<PerEntityHostedFamilyV5, EntityFamilySelectionV5>
}

export type ParseSeriesMetricSelectorsResultV5 =
  | {
      ok: true
      value: SeriesMetricSelectorsV5
    }
  | { ok: false; error: string }

type SelectorApplyResult = { ok: true } | { ok: false; error: string }

function applyHostSingletonSelectorV5(
  id: string,
  scope: MetricEntityScopeV5,
  hostCanonicalNames: Set<string>
): SelectorApplyResult {
  if (
    !HOST_SINGLETON_QUERYABLE_SCOPES_V5.has(scope) &&
    !HOST_SINGLETON_EXPLICIT_ONLY_SCOPES_V5.has(scope)
  ) {
    return {
      ok: false,
      error: `metric scope "${scope}" is reserved and not collected`,
    }
  }
  hostCanonicalNames.add(id)
  return { ok: true }
}

function applyEntityFamilySelectorV5(
  selector: EntityMetricSelector,
  entityId: string,
  entityFamilies: Map<PerEntityHostedFamilyV5, EntityFamilySelectionV5>
): SelectorApplyResult {
  const family = ENTITY_SCOPE_TO_FAMILY_V5[selector.scope]
  if (!family) {
    return {
      ok: false,
      error: `metric scope "${selector.scope}" has no entity-series mapping`,
    }
  }
  const selection = entityFamilies.get(family) ?? {
    entityIds: new Set<string>(),
    fields: new Set<string>(),
  }
  selection.entityIds.add(entityId)
  selection.fields.add(selector.field)
  entityFamilies.set(family, selection)
  return { ok: true }
}

function applySeriesMetricSelectorV5(
  id: string,
  hostCanonicalNames: Set<string>,
  entityFamilies: Map<PerEntityHostedFamilyV5, EntityFamilySelectionV5>
): SelectorApplyResult {
  let selector: EntityMetricSelector
  try {
    selector = parseEntityMetricId(id)
  } catch (err) {
    return { ok: false, error: metricsQueryErrorMessage(err) }
  }
  if (selector.entityId === undefined) {
    return applyHostSingletonSelectorV5(id, selector.scope, hostCanonicalNames)
  }
  return applyEntityFamilySelectorV5(selector, selector.entityId, entityFamilies)
}

/**
 * Parses `/servers/:id/metrics/series`'s `metrics` query param: a
 * comma-separated list of `entity-metric-id.ts` wire identities
 * (`host.cpu.busyPercent`, `network:eth0.receiveBytesPerSecond`,
 * `cpuDetail.averageFrequencyMHz`, `cpuCore:cpu3.busyPercent`, …). Absent or
 * blank defaults to every queryable `host.*` canonical name (never includes
 * the explicit-only `cpuDetail`/`memoryDetail` scopes — see
 * {@link HOST_SINGLETON_EXPLICIT_ONLY_SCOPES_V5}). Rejects an unparseable id,
 * an unknown/unqueryable scope, or too many selectors.
 */
export function parseSeriesMetricSelectorsV5(
  raw: string | undefined
): ParseSeriesMetricSelectorsResultV5 {
  const ids =
    raw === undefined
      ? []
      : raw
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
  if (ids.length === 0) {
    return {
      ok: true,
      value: {
        hostCanonicalNames: defaultHostCanonicalNamesV5(),
        entityFamilies: new Map(),
      },
    }
  }
  if (ids.length > MAX_SERIES_METRIC_SELECTORS_V5) {
    return {
      ok: false,
      error: `at most ${MAX_SERIES_METRIC_SELECTORS_V5} metrics may be requested at once`,
    }
  }

  const hostCanonicalNames = new Set<string>()
  const entityFamilies = new Map<PerEntityHostedFamilyV5, EntityFamilySelectionV5>()

  for (const id of ids) {
    const applied = applySeriesMetricSelectorV5(id, hostCanonicalNames, entityFamilies)
    if (!applied.ok) return applied
  }

  return {
    ok: true,
    value: { hostCanonicalNames: [...hostCanonicalNames], entityFamilies },
  }
}

/** Cache-key token list for `/series`: host canonical names plus `family:entityId.field` entity selectors. */
export function seriesCacheMetricsListV5(selectors: SeriesMetricSelectorsV5): string[] {
  return [
    ...selectors.hostCanonicalNames,
    ...[...selectors.entityFamilies.entries()].flatMap(([family, selection]) =>
      [...selection.entityIds].flatMap((entityId) =>
        [...selection.fields].map((field) => `${family}:${entityId}.${field}`)
      )
    ),
  ]
}

/**
 * The first requested `network`-family entity id that is a TurboFabric mesh
 * interface per the current topology inventory — such a device has no
 * reconstruction path on either backend (never embedded in `host.io`, never
 * paged as a standalone `network` row on Cloudflare; DuckDB does store it as
 * a full row, so this is a genuine cross-backend asymmetry, unlike a normal
 * NIC slot). Rejecting it here keeps the two backends answering the same
 * request the same way.
 *
 * A slot-mapped normal-NIC device is deliberately NOT rejected
 * here (unlike the pre-reconstruction behavior this replaces): Cloudflare
 * now reconstructs its `receiveBytesPerSecond`/`transmitBytesPerSecond` from
 * `host.io`'s own rows when `queryEntitySeries` is called with a resolved
 * `slotMapping`/`topologyGeneration` (see `types-v5.ts`'s
 * `EntitySeriesQueryV5` doc comment), and DuckDB already had the full row —
 * so both backends can answer, even though Cloudflare's answer is partial
 * (every other requested field resolves to `null` for that entity).
 *
 * Returns `null` when every requested id is independently addressable, or
 * when there is no topology inventory yet to check against (nothing to
 * reject without one).
 */
export function findFabricNetworkEntityId(
  entityIds: Iterable<string>,
  inventory: TopologyInventoryV5 | null
): string | null {
  if (!inventory) return null
  const fabric = new Set(
    inventory.networks.filter((device) => device.role === 'fabric').map((device) => device.deviceId)
  )
  for (const id of entityIds) {
    if (fabric.has(id)) return id
  }
  return null
}

/**
 * Error text when `/series` asked for a TurboFabric mesh interface as a
 * standalone `network` entity — same rejection {@link findFabricNetworkEntityId}
 * encodes, shaped for the HTTP 400 body.
 */
export function fabricNetworkSelectionErrorV5(
  selectors: SeriesMetricSelectorsV5,
  inventory: TopologyInventoryV5 | null
): string | null {
  const networkSelection = selectors.entityFamilies.get('network')
  if (!networkSelection) return null
  const fabricId = findFabricNetworkEntityId(networkSelection.entityIds, inventory)
  if (!fabricId) return null
  return (
    `network device "${fabricId}" is a fabric mesh interface per the current topology ` +
    `and cannot be queried as a standalone entity`
  )
}

// ---------------------------------------------------------------------------
// Topology context — inventory + slot mapping + host capacities for a single
// server's `/series` route, built from its latest recorded topology
// generation plus the operator-assigned hardware-profile overrides.
// ---------------------------------------------------------------------------

/** `hardwareProfile`'s topology-id overrides, projected into `computeSlotMapping`'s input shape — mirrors the daemon ingest route's `resolveSlotMappingForIngest` construction (`api-routes.ts`), never imported from there (daemon-side, ingest-scoped). */
export function topologyOverridesFromHardwareProfile(
  hardwareProfile: ServerHardwareProfile | undefined
): TopologyOverrides {
  return {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlotDeviceIds: hardwareProfile?.nicSlotDeviceIds ?? [],
    hostingFilesystemId: hardwareProfile?.hostingFilesystemId ?? null,
    drivetempEnabled: hardwareProfile?.drivetempEnabled ?? false,
  }
}

/** A snapshot is only usable for slot mapping once it carries every array `computeSlotMapping` reads — mirrors `api-routes.ts`'s `isSlotMappableTopologySnapshot`. */
function isSlotMappableTopologySnapshotV5(value: unknown): value is TopologySnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    Array.isArray(record.networks) &&
    Array.isArray(record.filesystems) &&
    Array.isArray(record.blockDevices) &&
    Array.isArray(record.gpus) &&
    Array.isArray(record.hardwareSignals)
  )
}

export const EMPTY_HOST_CAPACITIES_V5: HostCapacitiesV5 = {
  memoryTotalBytes: null,
  swapTotalBytes: null,
  rootFilesystemTotalBytes: null,
}

export type TopologyContextV5 = {
  topologyGeneration: number | null
  slotMapping: SlotMapping | null
  inventory: TopologyInventoryV5 | null
  capacities: HostCapacitiesV5
}

const EMPTY_TOPOLOGY_CONTEXT_V5: Omit<TopologyContextV5, 'topologyGeneration'> = {
  slotMapping: null,
  inventory: null,
  capacities: EMPTY_HOST_CAPACITIES_V5,
}

/**
 * Build the full topology context (`inventory`/`slotMapping`/host capacities)
 * a single-server `/series` route needs from its latest recorded topology
 * generation, or an empty-but-present context (never a throw) when there is
 * no usable snapshot yet — a server that has never reported topology, or
 * whose recorded snapshot predates `computeSlotMapping`'s required arrays.
 */
export function buildTopologyContextV5(
  record: { generation: number; snapshot: unknown } | undefined,
  hardwareProfile: ServerHardwareProfile | undefined
): TopologyContextV5 {
  const topologyGeneration = record?.generation ?? null
  if (!isSlotMappableTopologySnapshotV5(record?.snapshot)) {
    return { topologyGeneration, ...EMPTY_TOPOLOGY_CONTEXT_V5 }
  }
  const snapshot = record!.snapshot
  const overrides = topologyOverridesFromHardwareProfile(hardwareProfile)
  let slotMapping: SlotMapping
  try {
    slotMapping = computeSlotMapping(snapshot, overrides)
  } catch {
    return { topologyGeneration, ...EMPTY_TOPOLOGY_CONTEXT_V5 }
  }
  return {
    topologyGeneration,
    slotMapping,
    inventory: buildTopologyInventoryV5(snapshot, slotMapping),
    capacities: capacitiesFromSnapshotV5(snapshot, slotMapping),
  }
}

/**
 * Host capacity totals (RAM, swap, root filesystem) for one topology
 * snapshot. Split out of {@link buildTopologyContextV5} so the same
 * derivation can run against a *historical* generation — see
 * {@link buildCapacitiesByGenerationV5}.
 */
function capacitiesFromSnapshotV5(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): HostCapacitiesV5 {
  return {
    memoryTotalBytes: snapshot.memoryTotalBytes,
    swapTotalBytes: snapshot.swapTotalBytes,
    rootFilesystemTotalBytes: rootFilesystemTotalBytesV5(snapshot, slotMapping),
  }
}

/**
 * Capacity totals per topology generation, for the generations a queried
 * range actually spans.
 *
 * Capacities are the denominator of every derived percentage
 * (`memoryUsedPercent`, `rootFilesystemUsedPercent`). Resolving them once
 * from the latest generation — which is what v4 did — means adding RAM or
 * resizing a volume silently restates every historical point against the new
 * total, so a box that was at 90% memory last week reads as 45% today. Each
 * bucket carries the generation that was active when it was sampled, so this
 * maps that generation back to the capacities that were true at the time.
 *
 * A generation with no recorded snapshot, or one whose snapshot predates
 * `computeSlotMapping`'s required arrays, is omitted; the caller falls back
 * to the latest context's capacities for those points.
 */
export function buildCapacitiesByGenerationV5(
  records: ReadonlyMap<number, { snapshot: unknown }>,
  hardwareProfile: ServerHardwareProfile | undefined
): Map<number, HostCapacitiesV5> {
  const overrides = topologyOverridesFromHardwareProfile(hardwareProfile)
  const out = new Map<number, HostCapacitiesV5>()
  for (const [generation, record] of records) {
    if (!isSlotMappableTopologySnapshotV5(record.snapshot)) continue
    try {
      out.set(
        generation,
        capacitiesFromSnapshotV5(record.snapshot, computeSlotMapping(record.snapshot, overrides))
      )
    } catch {
      // A snapshot the slot mapper rejects contributes nothing rather than
      // failing the whole series query.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// `/servers/:id/metrics/series` response shaping — bundles the v5 host chart
// response with per-family entity series results and the topology context.
// ---------------------------------------------------------------------------

export type SeriesRouteResponseV5 = {
  ok: true
  serverId: string
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  resolutionSeconds: number | null
  host: HostSeriesChartResponseV5 | null
  entities: EntitySeriesResultV5[]
  inventory: TopologyInventoryV5 | null
  topologyGeneration: number | null
  cpuLimits: EffectiveCpuThermalLimits
  temperatureUnit: TemperatureUnit
  nicSlotLimit: number
}

export function buildSeriesRouteResponseV5(
  params: Readonly<{
    serverId: string
    from: string
    to: string
    backend: MetricsBackendKind
    resolutionSeconds: number | null
    host: HostSeriesChartResponseV5 | null
    entities: EntitySeriesResultV5[]
    context: TopologyContextV5
    envelope: CpuLimitsEnvelope
  }>
): SeriesRouteResponseV5 {
  const available =
    (params.host?.available ?? true) && params.entities.every((entity) => entity.available)
  return {
    ok: true,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: params.backend,
    available,
    resolutionSeconds: params.resolutionSeconds,
    host: params.host,
    entities: params.entities,
    inventory: params.context.inventory,
    topologyGeneration: params.context.topologyGeneration,
    cpuLimits: params.envelope.cpuLimits,
    temperatureUnit: params.envelope.temperatureUnit,
    nicSlotLimit: params.envelope.nicSlotLimit,
  }
}

/** Synthesized `HostSeriesResultV5`-shaped unavailable result when the resolved store has no `queryHostSeries` (e.g. `DisabledServerMetricsStoreV5`) — never a throw. */
export function unavailableHostSeriesResultV5(input: {
  serverId: string
  metrics: readonly string[]
  backend: MetricsBackendKind
}): {
  kind: MetricsBackendKind
  available: boolean
  serverId: string
  metrics: readonly string[]
  points: never[]
  resolutionSeconds: null
  gapCount: number
  sampleCount: number
} {
  return {
    kind: input.backend,
    available: false,
    serverId: input.serverId,
    metrics: input.metrics,
    points: [],
    resolutionSeconds: null,
    gapCount: 0,
    sampleCount: 0,
  }
}

/** Synthesized `EntitySeriesResultV5`-shaped unavailable result when the resolved store has no `queryEntitySeries` — never a throw. */
export function unavailableEntitySeriesResultV5(input: {
  serverId: string
  family: PerEntityHostedFamilyV5
  metrics: readonly string[]
  backend: MetricsBackendKind
}): EntitySeriesResultV5 {
  return {
    kind: input.backend,
    available: false,
    serverId: input.serverId,
    family: input.family,
    metrics: input.metrics,
    resolutionSeconds: null,
    entities: [],
  }
}

export type SeriesQueryInputV5 = {
  store: ServerMetricsStoreV5 | undefined
  backend: MetricsBackendKind
  serverId: string
  selectors: SeriesMetricSelectorsV5
  fromIso: string
  toIso: string
  resolutionSeconds: number
  context: TopologyContextV5
}

export type SeriesQueryOutcomeV5 =
  | {
      ok: true
      hostResult: HostSeriesResultV5 | null
      entityResults: EntitySeriesResultV5[]
    }
  | { ok: false }

/**
 * Fan-in host + per-family entity series reads for `/servers/:id/metrics/series`.
 * A store throw (backend unavailable) becomes `{ ok: false }` so the route can
 * 503 without duplicating the try/catch per family.
 */
export async function querySeriesResultsV5(
  input: SeriesQueryInputV5
): Promise<SeriesQueryOutcomeV5> {
  const hostOutcome = await queryHostSeriesForRouteV5(input)
  if (!hostOutcome.ok) return { ok: false }

  const entityResults: EntitySeriesResultV5[] = []
  for (const [family, selection] of input.selectors.entityFamilies) {
    const outcome = await queryOneEntityFamilySeriesV5(input, family, selection)
    if (!outcome.ok) return { ok: false }
    entityResults.push(outcome.result)
  }

  return { ok: true, hostResult: hostOutcome.hostResult, entityResults }
}

type HostSeriesQueryOutcomeV5 =
  | {
      ok: true
      hostResult: HostSeriesResultV5 | null
    }
  | { ok: false }

async function queryHostSeriesForRouteV5(
  input: SeriesQueryInputV5
): Promise<HostSeriesQueryOutcomeV5> {
  if (input.selectors.hostCanonicalNames.length === 0) {
    return { ok: true, hostResult: null }
  }
  try {
    const store = input.store
    if (!store?.queryHostSeries) {
      return {
        ok: true,
        hostResult: unavailableHostSeriesResultV5({
          serverId: input.serverId,
          metrics: input.selectors.hostCanonicalNames,
          backend: input.backend,
        }),
      }
    }
    const hostResult = await store.queryHostSeries({
      serverId: input.serverId,
      metrics: input.selectors.hostCanonicalNames,
      from: input.fromIso,
      to: input.toIso,
      resolutionSeconds: input.resolutionSeconds,
    })
    return {
      ok: true,
      hostResult,
    }
  } catch (err) {
    const message = metricsQueryErrorMessage(err)
    console.error(
      `metrics queryHostSeries failed backend=${input.backend} serverId=${input.serverId}: ${message}`
    )
    return { ok: false }
  }
}

type EntityFamilyQueryOutcomeV5 =
  | { ok: true; result: EntitySeriesResultV5 }
  | {
      ok: false
    }

async function queryOneEntityFamilySeriesV5(
  input: SeriesQueryInputV5,
  family: PerEntityHostedFamilyV5,
  selection: EntityFamilySelectionV5
): Promise<EntityFamilyQueryOutcomeV5> {
  const entityIds = [...selection.entityIds]
  const fields = [...selection.fields]
  const networkExtra =
    family === 'network'
      ? {
          slotMapping: input.context.slotMapping ?? undefined,
          topologyGeneration: input.context.topologyGeneration,
        }
      : {}
  try {
    const store = input.store
    if (!store?.queryEntitySeries) {
      return {
        ok: true,
        result: unavailableEntitySeriesResultV5({
          serverId: input.serverId,
          family,
          metrics: fields,
          backend: input.backend,
        }),
      }
    }
    return {
      ok: true,
      result: await store.queryEntitySeries({
        serverId: input.serverId,
        family,
        entityIds,
        metrics: fields,
        from: input.fromIso,
        to: input.toIso,
        resolutionSeconds: input.resolutionSeconds,
        ...networkExtra,
      }),
    }
  } catch (err) {
    const message = metricsQueryErrorMessage(err)
    console.error(
      `metrics queryEntitySeries failed backend=${input.backend} serverId=${input.serverId} family=${family}: ${message}`
    )
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// `/servers/metrics/latest` (fleet snapshot) — v5 host metric set + derived
// values from a batched topology-capacity join, kept O(1) in server count
// (one metrics query + one topology-generations query, never N).
// ---------------------------------------------------------------------------

/**
 * Metrics shown on the org servers overview (CPU stack + memory/swap).
 * Canonical v5 host names only — derived percentages (`memoryUsedPercent`,
 * `swapUsedPercent`) are computed by {@link buildFleetLatestPayloadV5} from
 * these plus each server's topology capacity, never stored/requested as
 * their own metric. v3's load-average fields (`load1`/`load5`/`load15`) have
 * no v5 analogue — the daemon contract carries no load-average metric at
 * all — so the fleet overview's load column has nothing to show post-cutover;
 * this is a known, deliberate capability gap, not an oversight.
 */
export const FLEET_HOST_METRICS_V5 = [
  'host.cpu.busyPercent',
  'host.cpu.userPercent',
  'host.cpu.systemPercent',
  'host.cpu.iowaitPercent',
  'host.memory.availableBytes',
  'host.memory.swapUsedBytes',
] as const

/**
 * `HostCapacitiesV5` for the fleet route from one server's topology
 * snapshot — memory/swap totals only (never `rootFilesystemTotalBytes`,
 * which needs a per-server `SlotMapping`/hardware-profile-override lookup
 * that would break this route's O(1)-in-server-count invariant; the fleet
 * overview never showed disk usage even pre-cutover).
 */
export function fleetHostCapacitiesFromSnapshotV5(snapshot: unknown): HostCapacitiesV5 {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return EMPTY_HOST_CAPACITIES_V5
  }
  const record = snapshot as Record<string, unknown>
  return {
    memoryTotalBytes: typeof record.memoryTotalBytes === 'number' ? record.memoryTotalBytes : null,
    swapTotalBytes: typeof record.swapTotalBytes === 'number' ? record.swapTotalBytes : null,
    rootFilesystemTotalBytes: null,
  }
}

export type FleetServerUsageRecordV5 = {
  serverId: string
  latestAt: string | null
  values: Partial<Record<string, number | null>>
  sampleCount: number
  topologyGeneration?: number | null
  derived: DerivedHostValuesV5
}

export type FleetLatestResponseV5 = {
  ok: true
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  metrics: readonly string[]
  servers: FleetServerUsageRecordV5[]
}

export function buildFleetLatestPayloadV5(
  params: Readonly<{
    from: string
    to: string
    backend: MetricsBackendKind
    available: boolean
    metrics: readonly string[]
    servers: Array<{
      serverId: string
      latestAt: string | null
      values: Partial<Record<string, number | null>>
      sampleCount: number
      topologyGeneration?: number | null
    }>
    capacitiesByServer: ReadonlyMap<string, HostCapacitiesV5>
  }>
): FleetLatestResponseV5 {
  return {
    ok: true,
    from: params.from,
    to: params.to,
    backend: params.backend,
    available: params.available,
    metrics: params.metrics,
    servers: params.servers.map((row) => ({
      ...row,
      derived: computeDerivedHostValuesV5(
        row.values,
        params.capacitiesByServer.get(row.serverId) ?? EMPTY_HOST_CAPACITIES_V5
      ),
    })),
  }
}

export function parseIsoTimestampQuery(
  raw: string | undefined,
  field: string
): IsoTimestampParseResult {
  if (!raw || raw.trim() === '') {
    return { ok: false, message: `${field} is required` }
  }
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) {
    return { ok: false, message: `${field} must be a valid ISO timestamp` }
  }
  return { ok: true, ms, iso: new Date(ms).toISOString() }
}

export function parseOptionalResolution(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

export function metricsBackendUnavailableResponse(backend: MetricsBackendKind): {
  ok: false
  error: 'metrics_backend_unavailable'
  backend: MetricsBackendKind
} {
  return {
    ok: false,
    error: 'metrics_backend_unavailable',
    backend,
  }
}

export type ConnectionHistoryChartResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  initialConnected: boolean | null
  uptimeSeconds: number
  downtimeSeconds: number
  unknownSeconds: number
  uptimePercent: number | null
  truncated: boolean
  events: StatusHistoryResult['events']
}

export function buildConnectionHistoryPayload(
  params: Readonly<{
    serverId: string
    from: string
    to: string
    result: StatusHistoryResult
  }>
): ConnectionHistoryChartResponse {
  const { result } = params
  return {
    ok: true,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: result.kind,
    available: result.available,
    initialConnected: result.initialConnected,
    uptimeSeconds: result.uptimeSeconds,
    downtimeSeconds: result.downtimeSeconds,
    unknownSeconds: result.unknownSeconds,
    uptimePercent: result.uptimePercent,
    truncated: result.truncated,
    events: result.events,
  }
}

/** True when connection history has something worth caching. */
export function connectionHistoryHasCacheableData(result: StatusHistoryResult): boolean {
  return result.events.length > 0 || result.uptimeSeconds > 0 || result.downtimeSeconds > 0
}

export type CpuLimitsEnvelope = {
  cpuLimits: EffectiveCpuThermalLimits
  temperatureUnit: TemperatureUnit
  /**
   * The server's effective monitored-NIC slot limit (`normalNicSlots` of its
   * resolved capability plan) — what the settings picker may let an operator
   * pin. Rides the same envelope as `cpuLimits` because both are per-server
   * facts the single-server routes already resolve and the UI reads together.
   */
  nicSlotLimit: number
}

/**
 * Compose the CPU-headroom + display-unit envelope shared by `/series` and
 * `/summary` — a pure function over already-resolved profile/org-options
 * inputs, no Hono `Context`. `/servers/metrics/latest` (fleet snapshot)
 * deliberately does not call this: attaching per-server `cpuLimits` there
 * would require N per-server hardware-profile lookups, breaking the O(1)
 * fleet-read invariant (see `AGENTS.md`).
 */
export function buildCpuLimitsEnvelope(
  hardwareProfile: ServerHardwareProfile | undefined,
  orgOptions: OrganizationOptions | null | undefined,
  nicSlotLimit: number
): CpuLimitsEnvelope {
  return {
    cpuLimits: resolveEffectiveCpuThermalLimits(hardwareProfile),
    temperatureUnit: resolveTemperatureUnit(orgOptions ?? {}),
    nicSlotLimit,
  }
}

export function buildHostSummaryPayload(
  params: Readonly<{
    serverId: string
    from: string
    to: string
    result: {
      kind: MetricsBackendKind
      available: boolean
      sampleCount: number
      latestAt: string | null
    }
    envelope: CpuLimitsEnvelope
  }>
) {
  return {
    ok: true as const,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: params.result.kind,
    available: params.result.available,
    sampleCount: params.result.sampleCount,
    latestAt: params.result.latestAt,
    cpuLimits: params.envelope.cpuLimits,
    temperatureUnit: params.envelope.temperatureUnit,
    nicSlotLimit: params.envelope.nicSlotLimit,
  }
}

export function metricsQueryErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type MetricEventsResponse = {
  ok: true
  serverId: string
  from: string
  to: string
  backend: MetricsBackendKind
  available: boolean
  events: MetricEventsResultV5['events']
  truncated: boolean
}

export function buildMetricEventsPayload(
  params: Readonly<{
    serverId: string
    from: string
    to: string
    result: MetricEventsResultV5
  }>
): MetricEventsResponse {
  const { result } = params
  return {
    ok: true,
    serverId: params.serverId,
    from: params.from,
    to: params.to,
    backend: result.kind,
    available: result.available,
    events: result.events,
    truncated: result.truncated,
  }
}

/** True when metric-events history has something worth caching. */
export function metricEventsHasCacheableData(result: MetricEventsResultV5): boolean {
  return result.events.length > 0
}
