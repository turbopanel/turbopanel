import {
  buildMetricsSampleV4,
  METRIC_EVENT_KINDS_V4,
  type MetricEventKindV4,
  type MetricEventSeverityV4,
  type MetricEventV4,
  METRICS_SCHEMA_VERSION_V4,
  type MetricsSampleMetadataV4,
  type MetricsSampleV4,
  type MetricsSampleV4Input,
  type NumaNodeSampleV4,
  sanitizeFinite,
} from './contract-v4.ts'
import { type MetricEntityScopeV4, sanitizeMetricValueV4 } from './metric-descriptors-v4.ts'
import type { AuthenticatedMetricsSampleV4 } from './types-v4.ts'

// ---------------------------------------------------------------------------
// Shared validation primitives — version/backend-neutral, this module is
// their sole surviving home after the v3 cutover.
// ---------------------------------------------------------------------------

export const MAX_METRICS_SKEW_MS = 300_000
export const MIN_INTERVAL_SECONDS = 1
export const MAX_INTERVAL_SECONDS = 3600
export const MAX_DIMENSION_LEN = 256
export const METRICS_LOG_COOLDOWN_MS = 5 * 60_000

const rateLimitedLogAt = new Map<string, number>()

/** Rate-limited diagnostic log — at most once per cooldown per serverId+reason. */
export function rateLimitedMetricsLog(
  serverId: string,
  reason: string,
  log: (message: string) => void,
  nowMs = Date.now()
): void {
  const key = `${serverId}\0${reason}`
  const last = rateLimitedLogAt.get(key)
  if (last !== undefined && nowMs - last < METRICS_LOG_COOLDOWN_MS) {
    return
  }
  rateLimitedLogAt.set(key, nowMs)
  log(reason)
}

/** Test seam: clear rate-limit cooldown map. */
export function resetMetricsRateLimitForTests(): void {
  rateLimitedLogAt.clear()
}

/** UTF-8 byte length of a WebSocket text frame (or ArrayBuffer frame). */
export function metricsPayloadByteLength(raw: string | ArrayBuffer): number {
  if (typeof raw === 'string') {
    return new TextEncoder().encode(raw).byteLength
  }
  return raw.byteLength
}

/**
 * Hard cap on raw v4 metrics frame size (UTF-8 bytes).
 *
 * Worst case: 7 bounded entity arrays (`networks`/`filesystems`/
 * `blockDevices`/`gpus`/`hardwareSignals`/`ingressSources`/`databaseProxies`)
 * × 64 entries (`MAX_METRIC_ENTITY_ARRAY_LENGTH_V4`) × ~250 bytes of JSON per
 * entry (generous for the widest entity, `ingressSources`, at 17 numeric
 * fields plus id/discriminator strings) + 128 events
 * (`MAX_METRIC_EVENTS_PER_SAMPLE_V4`) × ~150 bytes of JSON per event
 * (including a small `payload`) ≈ 7×64×250 + 128×150 = 112,000 + 19,200 ≈
 * 131,200 bytes (~129 KiB). Doubled for headroom (host block, metadata, JSON
 * key repetition, UTF-8 overhead) → 262,144 bytes (256 KiB).
 */
export const MAX_METRICS_PAYLOAD_BYTES_V4 = 262_144

/**
 * Defensive pre-construction caps — must stay in sync with the private
 * `MAX_METRIC_ENTITY_ARRAY_LENGTH` / `MAX_METRIC_EVENTS_PER_SAMPLE` constants
 * in `contract-v4.ts`. Rejecting oversized arrays here (with a clear reason)
 * is strictly better than letting `buildMetricsSampleV4` throw a generic
 * `TypeError`, but both layers must agree on the same ceiling.
 */
const MAX_METRIC_ENTITY_ARRAY_LENGTH_V4 = 64
const MAX_METRIC_EVENTS_PER_SAMPLE_V4 = 128

const MAX_EVENT_PAYLOAD_KEYS = 32

type ValidateFail = { ok: false; reason: string }
type ValidateOk<T> = { ok: true; value: T }
type ValidateResult<T> = ValidateOk<T> | ValidateFail

function fail(reason: string): ValidateFail {
  return { ok: false, reason: `metrics ${reason}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): ValidateFail | null {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return fail(`${label}.${key} is not a recognized field`)
    }
  }
  return null
}

/** Bounded non-empty string — used for entity ids, discriminators, and event identity fields. */
function readBoundedString(value: unknown, field: string): ValidateResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${field} must be a non-empty string`)
  }
  if (value.length > MAX_DIMENSION_LEN) {
    return fail(`${field} exceeds max length ${MAX_DIMENSION_LEN}`)
  }
  return { ok: true, value }
}

function readOptionalBoundedString(
  value: unknown,
  field: string
): ValidateResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  return readBoundedString(value, field)
}

function readClosedString<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  reason: string
): ValidateResult<T> {
  if (typeof value !== 'string' || !allowed.has(value)) {
    return fail(reason)
  }
  return { ok: true, value: value as T }
}

function parseSafeNonNegativeInteger(value: unknown, field: string): ValidateResult<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${field} must be a safe non-negative integer`)
  }
  return { ok: true, value }
}

function parseTimestamp(
  value: unknown,
  field: string,
  skew: { checkSkew: true; nowMs: number } | { checkSkew: false }
): ValidateResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${field} must be a non-empty string`)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    return fail(`${field} must be a valid ISO timestamp`)
  }
  if (skew.checkSkew && Math.abs(skew.nowMs - ms) > MAX_METRICS_SKEW_MS) {
    return fail(`${field} outside allowed skew window`)
  }
  return { ok: true, value }
}

function parseIntervalSeconds(value: unknown): ValidateResult<number> {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_INTERVAL_SECONDS ||
    value > MAX_INTERVAL_SECONDS
  ) {
    return fail(
      `metadata.intervalSeconds must be in [${MIN_INTERVAL_SECONDS}, ${MAX_INTERVAL_SECONDS}]`
    )
  }
  return { ok: true, value }
}

function rejectOversizedPayload(payloadBytes: number | undefined): ValidateFail | null {
  if (payloadBytes === undefined || payloadBytes <= MAX_METRICS_PAYLOAD_BYTES_V4) {
    return null
  }
  return fail(`payload exceeds max size ${MAX_METRICS_PAYLOAD_BYTES_V4}`)
}

function parseArray(raw: unknown, field: string, cap: number): ValidateResult<unknown[]> {
  if (!Array.isArray(raw)) {
    return fail(`${field} must be an array`)
  }
  if (raw.length > cap) {
    return fail(`${field} has ${raw.length} entries, exceeding the ${cap}-entry cap`)
  }
  return { ok: true, value: raw }
}

// ---------------------------------------------------------------------------
// Envelope / metadata
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'metadata',
  'host',
  'networks',
  'filesystems',
  'blockDevices',
  'gpus',
  'hardwareSignals',
  'ingressSources',
  'databaseProxies',
  'events',
  'cpuDetail',
  'memoryDetail',
  'cpuCoreLive',
  'numaNodes',
])

/** Top-level fields that only ever appear on a retired v3 frame — never on v4. */
const V3_ONLY_TOP_LEVEL_FIELDS = ['version', 'parts', 'dimensions', 'at']

function parseEnvelope(raw: unknown): ValidateResult<Record<string, unknown>> {
  if (!isRecord(raw)) return fail('payload must be an object')
  if (raw.type !== 'metrics') return fail('type must be "metrics"')

  if (!isRecord(raw.metadata)) {
    const looksLikeV3 = V3_ONLY_TOP_LEVEL_FIELDS.some((field) => field in raw)
    if (looksLikeV3) {
      return fail('payload uses retired schema v3 shape — daemon must upgrade to v4')
    }
    return fail('metadata must be an object')
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      return fail(`${key} is not a recognized v4 field`)
    }
  }
  return { ok: true, value: raw }
}

const ALLOWED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'sampledAt',
  'intervalSeconds',
  'sequence',
  'collectionMode',
  'topologyGeneration',
  'bootGeneration',
])

function parseMetadata(raw: unknown, nowMs: number): ValidateResult<MetricsSampleMetadataV4> {
  if (!isRecord(raw)) return fail('metadata must be an object')
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_METADATA_FIELDS.has(key)) {
      return fail(`metadata.${key} is not a recognized v4 metadata field`)
    }
  }
  if (raw.version !== METRICS_SCHEMA_VERSION_V4) {
    return fail(`metadata.version must be ${METRICS_SCHEMA_VERSION_V4}`)
  }
  const sampledAt = parseTimestamp(raw.sampledAt, 'metadata.sampledAt', {
    checkSkew: true,
    nowMs,
  })
  if (!sampledAt.ok) return sampledAt

  const intervalSeconds = parseIntervalSeconds(raw.intervalSeconds)
  if (!intervalSeconds.ok) return intervalSeconds

  const sequence = parseSafeNonNegativeInteger(raw.sequence, 'metadata.sequence')
  if (!sequence.ok) return sequence

  const topologyGeneration = parseSafeNonNegativeInteger(
    raw.topologyGeneration,
    'metadata.topologyGeneration'
  )
  if (!topologyGeneration.ok) return topologyGeneration

  const bootGeneration = parseSafeNonNegativeInteger(raw.bootGeneration, 'metadata.bootGeneration')
  if (!bootGeneration.ok) return bootGeneration

  if (raw.collectionMode !== 'baseline' && raw.collectionMode !== 'live') {
    return fail('metadata.collectionMode must be "baseline" or "live"')
  }

  return {
    ok: true,
    value: {
      version: METRICS_SCHEMA_VERSION_V4,
      sampledAt: sampledAt.value,
      intervalSeconds: intervalSeconds.value,
      sequence: sequence.value,
      collectionMode: raw.collectionMode,
      topologyGeneration: topologyGeneration.value,
      bootGeneration: bootGeneration.value,
    },
  }
}

// ---------------------------------------------------------------------------
// Generic numeric field-group parsing — shared by `host.*` sub-objects and
// the optional `cpuDetail`/`memoryDetail` blocks. `label` and `scope` are the
// same string for every caller in this file (they mirror
// `metric-descriptors-v4.ts`'s `<entityScope>.<fieldName>` naming), kept as
// separate parameters only because they serve different purposes (error
// messages vs. descriptor lookup).
// ---------------------------------------------------------------------------

function parseFieldGroup(
  raw: unknown,
  label: string,
  scope: MetricEntityScopeV4,
  numericFields: readonly string[]
): ValidateResult<Record<string, number | null>> {
  if (!isRecord(raw)) return fail(`${label} must be an object`)
  const allowed = new Set(numericFields)
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return fail(`${label}.${key} is not a recognized field`)
    }
  }
  const out: Record<string, number | null> = {}
  for (const field of numericFields) {
    const value = Object.hasOwn(raw, field) ? raw[field] : null
    if (value !== null && typeof value !== 'number') {
      return fail(`${label}.${field} must be a number or null`)
    }
    out[field] = sanitizeMetricValueV4(`${scope}.${field}`, value)
  }
  return { ok: true, value: out }
}

const HOST_CPU_NUMERIC_FIELDS = [
  'busyPercent',
  'userPercent',
  'systemPercent',
  'iowaitPercent',
  'stealPercent',
  'softirqPercent',
  'pressureSomePercent',
  'maxCoreBusyPercent',
  'procsRunning',
  'procsBlocked',
  'processCount',
] as const

const HOST_KERNEL_NUMERIC_FIELDS = ['fileHandlesUsedPercent', 'conntrackUsedPercent'] as const

const HOST_MEMORY_NUMERIC_FIELDS = [
  'availableBytes',
  'swapUsedBytes',
  'pressureSomePercent',
  'pressureFullPercent',
  'swapInBytesPerSecond',
  'swapOutBytesPerSecond',
  'majorPageFaultsPerSecond',
] as const

const HOST_STORAGE_NUMERIC_FIELDS = [
  'ioPressureSomePercent',
  'ioPressureFullPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'diskReadLatencyMs',
  'diskWriteLatencyMs',
  'maxBlockDeviceUtilPercent',
  'rootFilesystemAvailableBytes',
  'rootFilesystemFreeInodes',
] as const

const HOST_NETWORK_NUMERIC_FIELDS = ['tcpRetransmitPercent', 'softnetDropsPerSecond'] as const

const CPU_DETAIL_NUMERIC_FIELDS = [
  'averageFrequencyMHz',
  'minimumFrequencyMHz',
  'maximumFrequencyMHz',
  'contextSwitchesPerSecond',
  'interruptsPerSecond',
  'forksPerSecond',
  'cpuIrqPercent',
] as const

const MEMORY_DETAIL_NUMERIC_FIELDS = [
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

const ALLOWED_HOST_GROUPS: ReadonlySet<string> = new Set([
  'cpu',
  'kernel',
  'memory',
  'storage',
  'network',
])

function parseHost(raw: unknown): ValidateResult<MetricsSampleV4Input['host']> {
  if (!isRecord(raw)) return fail('host must be an object')
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_HOST_GROUPS.has(key)) {
      return fail(`host.${key} is not a recognized field`)
    }
  }
  const cpu = parseFieldGroup(raw.cpu, 'host.cpu', 'host.cpu', HOST_CPU_NUMERIC_FIELDS)
  if (!cpu.ok) return cpu
  const kernel = parseFieldGroup(
    raw.kernel,
    'host.kernel',
    'host.kernel',
    HOST_KERNEL_NUMERIC_FIELDS
  )
  if (!kernel.ok) return kernel
  const memory = parseFieldGroup(
    raw.memory,
    'host.memory',
    'host.memory',
    HOST_MEMORY_NUMERIC_FIELDS
  )
  if (!memory.ok) return memory
  const storage = parseFieldGroup(
    raw.storage,
    'host.storage',
    'host.storage',
    HOST_STORAGE_NUMERIC_FIELDS
  )
  if (!storage.ok) return storage
  const network = parseFieldGroup(
    raw.network,
    'host.network',
    'host.network',
    HOST_NETWORK_NUMERIC_FIELDS
  )
  if (!network.ok) return network

  return {
    ok: true,
    // Every field on each group was validated against its exact numeric
    // field list above, so this matches `MetricsSampleV4Input["host"]`'s
    // shape by construction.
    value: {
      cpu: cpu.value,
      kernel: kernel.value,
      memory: memory.value,
      storage: storage.value,
      network: network.value,
    } as MetricsSampleV4Input['host'],
  }
}

// ---------------------------------------------------------------------------
// Entity arrays — table-driven so every array shares one parse/sanitize path
// instead of seven near-identical hand-written loops. Canonical-name scopes
// intentionally don't match the array field names 1:1 (`networks` →
// `"network"`, `blockDevices` → `"block"`, `ingressSources` → `"ingress"`,
// `databaseProxies` → `"databaseProxy"`, `hardwareSignals` →
// `"hardwareSignal"`) — see `metric-descriptors-v4.ts`'s entity-scope naming.
// ---------------------------------------------------------------------------

type EntitySpecV4 = {
  arrayField: string
  idField: string
  /** `null` for entity types with no descriptor entry yet (e.g. `numaNodes`) — falls back to plain finite-sanitize. */
  scope: MetricEntityScopeV4 | null
  stringFields: readonly string[]
  numericFields: readonly string[]
}

function assignEntityNumericFields(
  spec: EntitySpecV4,
  raw: Record<string, unknown>,
  label: string,
  out: Record<string, unknown>
): ValidateFail | null {
  for (const field of spec.numericFields) {
    const value = Object.hasOwn(raw, field) ? raw[field] : null
    if (value !== null && typeof value !== 'number') {
      return fail(`${label}.${field} must be a number or null`)
    }
    const numeric = value as number | null
    out[field] = spec.scope
      ? sanitizeMetricValueV4(`${spec.scope}.${field}`, numeric)
      : sanitizeFinite(numeric)
  }
  return null
}

function parseEntityEntry(
  spec: EntitySpecV4,
  raw: unknown,
  index: number
): ValidateResult<Record<string, unknown>> {
  const label = `${spec.arrayField}[${index}]`
  if (!isRecord(raw)) return fail(`${label} must be an object`)

  const unknown = rejectUnknownKeys(
    raw,
    new Set([spec.idField, ...spec.stringFields, ...spec.numericFields]),
    label
  )
  if (unknown) return unknown

  const id = readBoundedString(raw[spec.idField], `${label}.${spec.idField}`)
  if (!id.ok) return id

  const out: Record<string, unknown> = { [spec.idField]: id.value }

  for (const field of spec.stringFields) {
    const parsed = readBoundedString(raw[field], `${label}.${field}`)
    if (!parsed.ok) return parsed
    out[field] = parsed.value
  }

  const numeric = assignEntityNumericFields(spec, raw, label, out)
  if (numeric) return numeric

  return { ok: true, value: out }
}

function parseEntityArray<T>(raw: unknown, spec: EntitySpecV4, cap: number): ValidateResult<T[]> {
  const arr = parseArray(raw, spec.arrayField, cap)
  if (!arr.ok) return arr

  const out: T[] = []
  for (let i = 0; i < arr.value.length; i++) {
    const entry = parseEntityEntry(spec, arr.value[i], i)
    if (!entry.ok) return entry
    // Every key was checked against `spec`'s exact field lists above, so
    // this matches the RawInput<…> shape `buildMetricsSampleV4` expects.
    out.push(entry.value as T)
  }
  return { ok: true, value: out }
}

const NETWORK_SPEC: EntitySpecV4 = {
  arrayField: 'networks',
  idField: 'deviceId',
  scope: 'network',
  stringFields: [],
  numericFields: [
    'receiveBytesPerSecond',
    'transmitBytesPerSecond',
    'receiveErrorsPerSecond',
    'transmitErrorsPerSecond',
    'receiveDropsPerSecond',
    'transmitDropsPerSecond',
  ],
}

const FILESYSTEM_SPEC: EntitySpecV4 = {
  arrayField: 'filesystems',
  idField: 'filesystemId',
  scope: 'filesystem',
  stringFields: [],
  numericFields: ['availableBytes', 'freeInodes'],
}

const BLOCK_DEVICE_SPEC: EntitySpecV4 = {
  arrayField: 'blockDevices',
  idField: 'deviceId',
  scope: 'block',
  stringFields: [],
  numericFields: [
    'readBytesPerSecond',
    'writeBytesPerSecond',
    'readOpsPerSecond',
    'writeOpsPerSecond',
    'readLatencyMs',
    'writeLatencyMs',
    'utilizationPercent',
    'temperatureCelsius',
    'queueDepth',
  ],
}

const GPU_SPEC: EntitySpecV4 = {
  arrayField: 'gpus',
  idField: 'gpuId',
  scope: 'gpu',
  stringFields: [],
  numericFields: [
    'utilizationPercent',
    'memoryUsedBytes',
    'memoryActivityPercent',
    'temperatureCelsius',
    'memoryTemperatureCelsius',
    'powerWatts',
    'pcieReceiveBytesPerSecond',
    'pcieTransmitBytesPerSecond',
    'throttlePercent',
  ],
}

const HARDWARE_SIGNAL_SPEC: EntitySpecV4 = {
  arrayField: 'hardwareSignals',
  idField: 'signalId',
  scope: 'hardwareSignal',
  stringFields: ['kind'],
  numericFields: ['value'],
}

const INGRESS_SPEC: EntitySpecV4 = {
  arrayField: 'ingressSources',
  idField: 'sourceId',
  scope: 'ingress',
  stringFields: ['sourceKind'],
  numericFields: [
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
  ],
}

const DATABASE_PROXY_SPEC: EntitySpecV4 = {
  arrayField: 'databaseProxies',
  idField: 'sourceId',
  scope: 'databaseProxy',
  stringFields: ['sourceKind'],
  numericFields: [
    'queries',
    'slowQueries',
    'connectionErrors',
    'clientConnections',
    'backendConnections',
    'backendsUp',
  ],
}

/** No descriptor entry exists yet for `numaNodes` — see `EntitySpecV4.scope` doc. */
const NUMA_NODE_SPEC: EntitySpecV4 = {
  arrayField: 'numaNodes',
  idField: 'nodeId',
  scope: null,
  stringFields: [],
  numericFields: [
    'freeBytes',
    'totalBytes',
    'localAllocationsPerSecond',
    'foreignAllocationsPerSecond',
  ],
}

const CPU_HOTSPOT_SPEC: EntitySpecV4 = {
  arrayField: 'cpuDetail.hotspots',
  idField: 'coreId',
  scope: 'cpuHotspot',
  stringFields: [],
  numericFields: ['busyPercent', 'iowaitPercent', 'stealPercent'],
}

const CPU_CORE_LIVE_SPEC: EntitySpecV4 = {
  arrayField: 'cpuCoreLive',
  idField: 'coreId',
  scope: 'cpuCore',
  stringFields: [],
  numericFields: ['busyPercent', 'iowaitPercent', 'stealPercent'],
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const METRIC_EVENT_KIND_SET: ReadonlySet<string> = new Set(METRIC_EVENT_KINDS_V4)
const EVENT_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warning', 'critical'])
const ALLOWED_EVENT_FIELDS: ReadonlySet<string> = new Set([
  'eventId',
  'at',
  'kind',
  'severity',
  'entityId',
  'source',
  'payload',
])

type EventPayloadScalar = string | number | boolean | null
type EventPayloadRecord = Record<string, EventPayloadScalar>

function parseEventPayloadScalar(
  value: unknown,
  field: string
): ValidateResult<EventPayloadScalar> {
  if (value === null || typeof value === 'boolean') {
    return { ok: true, value }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail(`${field} must be finite`)
    }
    return { ok: true, value }
  }
  if (typeof value === 'string') {
    if (value.length > MAX_DIMENSION_LEN) {
      return fail(`${field} exceeds max length ${MAX_DIMENSION_LEN}`)
    }
    return { ok: true, value }
  }
  return fail(`${field} must be a string, number, boolean, or null`)
}

function parseEventPayload(
  raw: unknown,
  label: string
): ValidateResult<EventPayloadRecord | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!isRecord(raw)) return fail(`${label} must be an object`)

  const keys = Object.keys(raw)
  if (keys.length > MAX_EVENT_PAYLOAD_KEYS) {
    return fail(`${label} has ${keys.length} keys, exceeding the ${MAX_EVENT_PAYLOAD_KEYS}-key cap`)
  }

  const out: EventPayloadRecord = {}
  for (const key of keys) {
    if (key.length > MAX_DIMENSION_LEN) {
      return fail(`${label} key exceeds max length ${MAX_DIMENSION_LEN}`)
    }
    const parsed = parseEventPayloadScalar(raw[key], `${label}.${key}`)
    if (!parsed.ok) return parsed
    out[key] = parsed.value
  }
  return { ok: true, value: out }
}

function assignOptionalEventString(
  event: MetricEventV4,
  key: 'entityId' | 'source',
  raw: unknown,
  field: string
): ValidateFail | null {
  const parsed = readOptionalBoundedString(raw, field)
  if (!parsed.ok) return parsed
  if (parsed.value !== undefined) event[key] = parsed.value
  return null
}

function parseEvent(raw: unknown, index: number): ValidateResult<MetricEventV4> {
  const label = `events[${index}]`
  if (!isRecord(raw)) return fail(`${label} must be an object`)
  const unknown = rejectUnknownKeys(raw, ALLOWED_EVENT_FIELDS, label)
  if (unknown) return unknown

  const eventId = readBoundedString(raw.eventId, `${label}.eventId`)
  if (!eventId.ok) return eventId

  // Buffered events legitimately predate `metadata.sampledAt` by more than
  // the skew window (e.g. an OOM kill discovered on the next tick) — only
  // ISO validity is enforced, never `MAX_METRICS_SKEW_MS`.
  const at = parseTimestamp(raw.at, `${label}.at`, { checkSkew: false })
  if (!at.ok) return at

  const kind = readClosedString<MetricEventKindV4>(
    raw.kind,
    METRIC_EVENT_KIND_SET,
    `${label}.kind is not a recognized event kind`
  )
  if (!kind.ok) return kind

  const severity = readClosedString<MetricEventSeverityV4>(
    raw.severity,
    EVENT_SEVERITIES,
    `${label}.severity must be "info", "warning", or "critical"`
  )
  if (!severity.ok) return severity

  const event: MetricEventV4 = {
    eventId: eventId.value,
    at: at.value,
    kind: kind.value,
    severity: severity.value,
  }

  const entityId = assignOptionalEventString(event, 'entityId', raw.entityId, `${label}.entityId`)
  if (entityId) return entityId
  const source = assignOptionalEventString(event, 'source', raw.source, `${label}.source`)
  if (source) return source

  const payload = parseEventPayload(raw.payload, `${label}.payload`)
  if (!payload.ok) return payload
  if (payload.value !== undefined) event.payload = payload.value

  return { ok: true, value: event }
}

function parseEvents(raw: unknown): ValidateResult<MetricEventV4[]> {
  const arr = parseArray(raw, 'events', MAX_METRIC_EVENTS_PER_SAMPLE_V4)
  if (!arr.ok) return arr

  const events: MetricEventV4[] = []
  for (let i = 0; i < arr.value.length; i++) {
    const event = parseEvent(arr.value[i], i)
    if (!event.ok) return event
    events.push(event.value)
  }
  return { ok: true, value: events }
}

// ---------------------------------------------------------------------------
// Top-level validation
// ---------------------------------------------------------------------------

type RequiredEntityArrays = {
  networks: MetricsSampleV4Input['networks']
  filesystems: MetricsSampleV4Input['filesystems']
  blockDevices: MetricsSampleV4Input['blockDevices']
  gpus: MetricsSampleV4Input['gpus']
  hardwareSignals: MetricsSampleV4Input['hardwareSignals']
  ingressSources: MetricsSampleV4Input['ingressSources']
  databaseProxies: MetricsSampleV4Input['databaseProxies']
}

const REQUIRED_ENTITY_SPECS: readonly {
  key: keyof RequiredEntityArrays
  spec: EntitySpecV4
}[] = [
  { key: 'networks', spec: NETWORK_SPEC },
  { key: 'filesystems', spec: FILESYSTEM_SPEC },
  { key: 'blockDevices', spec: BLOCK_DEVICE_SPEC },
  { key: 'gpus', spec: GPU_SPEC },
  { key: 'hardwareSignals', spec: HARDWARE_SIGNAL_SPEC },
  { key: 'ingressSources', spec: INGRESS_SPEC },
  { key: 'databaseProxies', spec: DATABASE_PROXY_SPEC },
]

function parseRequiredEntityArrays(
  envelope: Record<string, unknown>
): ValidateResult<RequiredEntityArrays> {
  const out: Record<string, unknown> = {}
  for (const { key, spec } of REQUIRED_ENTITY_SPECS) {
    const parsed = parseEntityArray(envelope[key], spec, MAX_METRIC_ENTITY_ARRAY_LENGTH_V4)
    if (!parsed.ok) return parsed
    out[key] = parsed.value
  }
  return { ok: true, value: out as RequiredEntityArrays }
}

function parseOptionalEntityArray<T>(
  raw: unknown,
  spec: EntitySpecV4
): ValidateResult<T[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  return parseEntityArray<T>(raw, spec, MAX_METRIC_ENTITY_ARRAY_LENGTH_V4)
}

function parseCpuDetail(
  raw: unknown
): ValidateResult<NonNullable<MetricsSampleV4Input['cpuDetail']>> {
  if (!isRecord(raw)) return fail('cpuDetail must be an object')
  const unknown = rejectUnknownKeys(
    raw,
    new Set(['hotspots', ...CPU_DETAIL_NUMERIC_FIELDS]),
    'cpuDetail'
  )
  if (unknown) return unknown
  const hotspots = parseEntityArray(raw.hotspots, CPU_HOTSPOT_SPEC, 4)
  if (!hotspots.ok) return hotspots
  const rawCpuDetailScalars = { ...raw }
  delete rawCpuDetailScalars.hotspots
  const scalars = parseFieldGroup(
    rawCpuDetailScalars,
    'cpuDetail',
    'cpuDetail',
    CPU_DETAIL_NUMERIC_FIELDS
  )
  if (!scalars.ok) return scalars
  return {
    ok: true,
    value: {
      ...scalars.value,
      hotspots: hotspots.value,
    } as NonNullable<MetricsSampleV4Input['cpuDetail']>,
  }
}

type OptionalSampleParts = {
  cpuDetail?: NonNullable<MetricsSampleV4Input['cpuDetail']>
  memoryDetail?: NonNullable<MetricsSampleV4Input['memoryDetail']>
  cpuCoreLive?: NonNullable<MetricsSampleV4Input['cpuCoreLive']>
  numaNodes?: NonNullable<MetricsSampleV4Input['numaNodes']>
}

function parseOptionalSampleParts(
  envelope: Record<string, unknown>
): ValidateResult<OptionalSampleParts> {
  const numaNodes = parseOptionalEntityArray<NumaNodeSampleV4>(envelope.numaNodes, NUMA_NODE_SPEC)
  if (!numaNodes.ok) return numaNodes

  let cpuDetail: MetricsSampleV4Input['cpuDetail']
  if (envelope.cpuDetail !== undefined) {
    const parsed = parseCpuDetail(envelope.cpuDetail)
    if (!parsed.ok) return parsed
    cpuDetail = parsed.value
  }

  let memoryDetail: MetricsSampleV4Input['memoryDetail']
  if (envelope.memoryDetail !== undefined) {
    const parsed = parseFieldGroup(
      envelope.memoryDetail,
      'memoryDetail',
      'memoryDetail',
      MEMORY_DETAIL_NUMERIC_FIELDS
    )
    if (!parsed.ok) return parsed
    memoryDetail = parsed.value as MetricsSampleV4Input['memoryDetail']
  }

  const cpuCoreLive = parseOptionalEntityArray(envelope.cpuCoreLive, CPU_CORE_LIVE_SPEC)
  if (!cpuCoreLive.ok) return cpuCoreLive

  return {
    ok: true,
    value: {
      numaNodes: numaNodes.value,
      cpuDetail,
      memoryDetail,
      cpuCoreLive: cpuCoreLive.value as MetricsSampleV4Input['cpuCoreLive'],
    },
  }
}

function caughtSampleError(err: unknown): ValidateFail {
  return {
    ok: false,
    reason: err instanceof Error ? err.message : 'metrics sample invalid',
  }
}

/**
 * Validate a raw daemon metrics frame against the v4 wire contract.
 * `serverId` always comes from `ctx` — never from the client payload.
 */
export function validateMetricsSampleV4(
  raw: unknown,
  ctx: {
    serverId: string
    receivedAt: string
    nowMs?: number
    /** Raw frame UTF-8 byte length; rejects when over `MAX_METRICS_PAYLOAD_BYTES_V4`. */
    payloadBytes?: number
  }
): { ok: true; sample: AuthenticatedMetricsSampleV4 } | { ok: false; reason: string } {
  const oversized = rejectOversizedPayload(ctx.payloadBytes)
  if (oversized) return oversized

  const envelope = parseEnvelope(raw)
  if (!envelope.ok) return envelope

  const nowMs = ctx.nowMs ?? Date.now()

  const metadata = parseMetadata(envelope.value.metadata, nowMs)
  if (!metadata.ok) return metadata

  const host = parseHost(envelope.value.host)
  if (!host.ok) return host

  const entities = parseRequiredEntityArrays(envelope.value)
  if (!entities.ok) return entities

  const events = parseEvents(envelope.value.events)
  if (!events.ok) return events

  const optionals = parseOptionalSampleParts(envelope.value)
  if (!optionals.ok) return optionals

  let built: MetricsSampleV4
  try {
    built = buildMetricsSampleV4({
      metadata: metadata.value,
      host: host.value,
      ...entities.value,
      events: events.value,
      ...optionals.value,
    })
  } catch (err) {
    return caughtSampleError(err)
  }

  return {
    ok: true,
    sample: {
      ...built,
      serverId: ctx.serverId,
      receivedAt: ctx.receivedAt,
    },
  }
}
