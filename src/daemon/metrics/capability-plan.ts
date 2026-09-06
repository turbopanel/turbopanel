/**
 * Metrics capability plan (v4) — backend-neutral entitlement model for how
 * much of the v4 metrics contract (`contract-v4.ts`) a given server is
 * allowed to report/store. Deliberately carries no pricing-tier names or
 * literals: this module only knows about slot counts and feature toggles,
 * never about what plan/SKU produced them. Org-wide defaults live in
 * `organization.options.metricsCapabilityPlan` (`../../lib/organization-options.ts`),
 * an optional per-server override lives in `server.options.metricsCapabilityPlan`
 * (read the same way `server-metadata.ts` reads `cpuTdpWattsOverride`), and
 * {@link resolveMetricsCapabilityPlan} layers platform default → org →
 * server, mirroring `resolveEffectiveCpuThermalLimits`.
 *
 * Ingest call site: `POST /api/daemon/v1/metrics` (`api-routes.ts`) resolves
 * the effective plan for the reporting server via
 * `resolveEffectiveMetricsCapabilityPlan` (`server-metadata.ts`), calls
 * {@link truncateSampleToCapabilityPlanV4} on the incoming `MetricsSampleV4`,
 * then hands the truncated sample to the store.
 */

import { isHardwareHealthEventKindV4, type MetricsSampleV4 } from './contract-v4.ts'
import type { SlotMapping } from '../../client/servers/topology-types.ts'

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export type MetricsCapabilityPlanV4 = {
  /** Steady-state sampling cadence, seconds. */
  baselineIntervalSeconds: number
  /** Fastest cadence a "live" on-demand session may request, seconds. */
  liveMinIntervalSeconds: number
  /** Number of `networks` entries billed as "normal" NIC slots. */
  normalNicSlots: number
  /** Whether TurboFabric mesh interfaces may report beyond the normal NIC slots. */
  turboFabricEnabled: boolean
  /** Additional `filesystems` entries allowed beyond root-filesystem host metrics. */
  extraFilesystemSlots: number
  /** `blockDevices` entries allowed (per-disk detail; 0 = none). */
  detailedBlockDeviceSlots: number
  /** `gpus` entries allowed. */
  gpuSlots: number
  /** Whether GPU interconnect (NVLink/etc) signals may be reported. */
  gpuInterconnectEnabled: boolean
  /** `hardwareSignals` entries allowed (fans/voltages/PSU/etc). */
  physicalHardwareSignalSlots: number
  /** Whether `cpuDetail` (per-core breakdown) may be reported. */
  cpuDetailEnabled: boolean
  /** Reserved slot count for live per-core CPU detail. */
  cpuLiveCoreSlots: number
  /** Whether `memoryDetail` (hugepages/slab/dirty) may be reported. */
  memoryDetailEnabled: boolean
  /** `numaNodes` entries allowed. */
  numaNodeSlots: number
  /** Whether `ingressSources` may be reported. */
  managedIngressEnabled: boolean
  /** Whether `databaseProxies` may be reported. */
  databaseProxyMetricsEnabled: boolean
  /** Whether hardware-health `events` may be reported. */
  hardwareHealthEventsEnabled: boolean
}

/** Field order used for canonical serialization ({@link computeMetricsCapabilityPlanHash}). */
const METRICS_CAPABILITY_PLAN_FIELD_ORDER = [
  'baselineIntervalSeconds',
  'liveMinIntervalSeconds',
  'normalNicSlots',
  'turboFabricEnabled',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'gpuInterconnectEnabled',
  'physicalHardwareSignalSlots',
  'cpuDetailEnabled',
  'cpuLiveCoreSlots',
  'memoryDetailEnabled',
  'numaNodeSlots',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlanV4)[]

/**
 * Per-server machine classification driving {@link platformDefaultMetricsCapabilityPlan}.
 * Not derived from any stored field yet — the caller (later phase: ingest,
 * once server topology/hardware detection is wired) is responsible for
 * classifying the reporting server. No default is offered here: a silent
 * fallback would recreate the "every server gets the same plan" bug this
 * type exists to fix.
 */
export type ServerMachineClass = 'physical' | 'virtual'

/**
 * Platform fallback applied when neither org nor server override a field.
 * `physicalHardwareSignalSlots` reflects the `"physical"` baseline — use
 * {@link platformDefaultMetricsCapabilityPlan} (or
 * {@link resolveMetricsCapabilityPlan}) to get the per-machine-class default,
 * since a virtual machine has no host-level fan/voltage/PSU/etc. sensors to
 * report.
 */
export const PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN: MetricsCapabilityPlanV4 = {
  baselineIntervalSeconds: 60,
  liveMinIntervalSeconds: 10,
  normalNicSlots: 2,
  turboFabricEnabled: true,
  extraFilesystemSlots: 0,
  detailedBlockDeviceSlots: 0,
  gpuSlots: 1,
  gpuInterconnectEnabled: false,
  physicalHardwareSignalSlots: 19,
  cpuDetailEnabled: false,
  cpuLiveCoreSlots: 0,
  memoryDetailEnabled: false,
  numaNodeSlots: 0,
  managedIngressEnabled: true,
  databaseProxyMetricsEnabled: true,
  hardwareHealthEventsEnabled: true,
}

/**
 * Platform default plan for a given {@link ServerMachineClass} — every field
 * matches {@link PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN} except
 * `physicalHardwareSignalSlots`, which is `19` only for `"physical"` and `0`
 * for `"virtual"`.
 */
export function platformDefaultMetricsCapabilityPlan(
  machineClass: ServerMachineClass
): MetricsCapabilityPlanV4 {
  return {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    physicalHardwareSignalSlots:
      machineClass === 'physical'
        ? PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.physicalHardwareSignalSlots
        : 0,
  }
}

/** Partial override layer — org-wide (`organization.options`) or per-server (`server.options`). */
export type MetricsCapabilityPlanOverrideV4 = Partial<MetricsCapabilityPlanV4>

const POSITIVE_INT_FIELDS = [
  'baselineIntervalSeconds',
  'liveMinIntervalSeconds',
] as const satisfies readonly (keyof MetricsCapabilityPlanV4)[]

const NON_NEGATIVE_INT_FIELDS = [
  'normalNicSlots',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'physicalHardwareSignalSlots',
  'cpuLiveCoreSlots',
  'numaNodeSlots',
] as const satisfies readonly (keyof MetricsCapabilityPlanV4)[]

const BOOLEAN_FIELDS = [
  'turboFabricEnabled',
  'gpuInterconnectEnabled',
  'cpuDetailEnabled',
  'memoryDetailEnabled',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlanV4)[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Parse a `metricsCapabilityPlan` override (org or server layer) from stored
 * jsonb. Every field is validated independently — unknown keys, wrong types,
 * non-integer numbers, and out-of-range numbers are all silently omitted
 * rather than rejecting the whole object, matching the
 * `parseOrganizationOptions` idiom.
 */
export function parseMetricsCapabilityPlanOverride(
  value: unknown
): MetricsCapabilityPlanOverrideV4 {
  if (!isRecord(value)) return {}
  const override: MetricsCapabilityPlanOverrideV4 = {}
  for (const key of POSITIVE_INT_FIELDS) {
    if (isPositiveInteger(value[key])) override[key] = value[key] as number
  }
  for (const key of NON_NEGATIVE_INT_FIELDS) {
    if (isNonNegativeInteger(value[key])) override[key] = value[key] as number
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof value[key] === 'boolean') override[key] = value[key] as boolean
  }
  return override
}

/**
 * Parse a `metricsCapabilityPlan` override nested under `server.options`.
 * Same parse discipline as {@link parseMetricsCapabilityPlanOverride} — kept
 * as a distinct export so call sites read as "server layer" vs. "org layer"
 * without relying on a shared name to convey that.
 */
export function parseServerMetricsCapabilityPlanOverride(
  value: unknown
): MetricsCapabilityPlanOverrideV4 {
  return parseMetricsCapabilityPlanOverride(value)
}

/**
 * Resolve the effective plan: per-machine-class platform default → org
 * override → server override, field by field (a later layer only wins for
 * fields it actually sets — {@link parseMetricsCapabilityPlanOverride} never
 * emits a key it couldn't validate, so partial layers compose safely).
 *
 * `machineClass` is required (not defaulted) so a virtual server can never
 * silently inherit the physical `physicalHardwareSignalSlots` baseline — see
 * {@link platformDefaultMetricsCapabilityPlan}. An explicit org/server
 * override for that field still wins over the machine-class default, same as
 * any other field.
 */
export function resolveMetricsCapabilityPlan(
  machineClass: ServerMachineClass,
  orgOverride: MetricsCapabilityPlanOverrideV4 | undefined,
  serverOverride: MetricsCapabilityPlanOverrideV4 | undefined
): MetricsCapabilityPlanV4 {
  return {
    ...platformDefaultMetricsCapabilityPlan(machineClass),
    ...orgOverride,
    ...serverOverride,
  }
}

/**
 * Deterministic SHA-256 hex digest of a resolved plan — used to detect
 * whether a server's effective plan actually changed between resolutions
 * (see `capability-plan-records.ts`). Domain-separated so this can never be
 * confused with a hash of the same field values computed elsewhere. Uses Web
 * Crypto (`crypto.subtle`) only — safe on both Workers and Deno, no Node-only
 * APIs.
 */
export async function computeMetricsCapabilityPlanHash(
  plan: MetricsCapabilityPlanV4
): Promise<string> {
  const canonical = METRICS_CAPABILITY_PLAN_FIELD_ORDER.map((key) => [key, plan[key]] as const)
  const material = new TextEncoder().encode(
    `turbopanel:metrics-capability-plan:${JSON.stringify(canonical)}`
  )
  const digest = await crypto.subtle.digest('SHA-256', material)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// Enforcement — truncate a discovered v4 sample down to plan entitlements.
// ---------------------------------------------------------------------------

/**
 * Truncate a `MetricsSampleV4`'s presence-gated entity arrays/optionals down
 * to what `plan` entitles, without ever fabricating an entity that wasn't
 * present (0 discovered stays 0 regardless of the slot count). Pure — no I/O,
 * no mutation of `sample`.
 *
 * Notes for later phases:
 * - `filesystems` truncation: the daemon's collector no longer emits the
 *   root-tagged filesystem into `sample.filesystems[]` at all (its capacity
 *   lives exclusively in `host.storage`'s `rootFilesystemAvailableBytes`/
 *   `rootFilesystemFreeInodes` — see `turbopaneld`'s
 *   `collector/filesystem.ts`), but this truncation still defensively drops
 *   any entry matching `slotMapping.rootFilesystemId` before applying
 *   `extraFilesystemSlots`, so an older daemon that still reports root in
 *   `filesystems[]` can never spend a slot budget on `/` itself.
 * - `events` filters out only the hardware-health kinds
 *   (`isHardwareHealthEventKindV4`, `contract-v4.ts`) when
 *   `hardwareHealthEventsEnabled` is false; every other kind (OS/kernel,
 *   filesystem, fabric, clock-sync, topology/boot generation) is unrelated
 *   operational history and always survives.
 * - `networks` is intentionally untouched here — `normalNicSlots` /
 *   `turboFabricEnabled` inform the topology *packer* in a later phase, not
 *   sample truncation.
 */
/**
 * Conservative fallback plan resolution — platform defaults only, always
 * `"virtual"` machine class (no host-level hardware-signal slots granted).
 * Ingest (`api-routes.ts`) uses `resolveEffectiveMetricsCapabilityPlan`
 * (`server-metadata.ts`) for the real, persisted-state resolution and falls
 * back to this only when no DB is available for the request or the real
 * resolution itself fails — never as the default path.
 */
export function resolveDefaultMetricsCapabilityPlanV4(): MetricsCapabilityPlanV4 {
  return resolveMetricsCapabilityPlan('virtual', undefined, undefined)
}

export function truncateSampleToCapabilityPlanV4(
  sample: MetricsSampleV4,
  plan: MetricsCapabilityPlanV4,
  slotMapping?: SlotMapping
): MetricsSampleV4 {
  const nonRootFilesystems = slotMapping?.rootFilesystemId
    ? sample.filesystems.filter((fs) => fs.filesystemId !== slotMapping.rootFilesystemId)
    : sample.filesystems
  const truncated: MetricsSampleV4 = {
    ...sample,
    gpus: sample.gpus.slice(0, plan.gpuSlots),
    blockDevices: sample.blockDevices.slice(0, plan.detailedBlockDeviceSlots),
    filesystems: nonRootFilesystems.slice(0, plan.extraFilesystemSlots),
    hardwareSignals: sample.hardwareSignals.slice(0, plan.physicalHardwareSignalSlots),
    ingressSources: plan.managedIngressEnabled ? sample.ingressSources : [],
    databaseProxies: plan.databaseProxyMetricsEnabled ? sample.databaseProxies : [],
    events: plan.hardwareHealthEventsEnabled
      ? sample.events
      : sample.events.filter((event) => !isHardwareHealthEventKindV4(event.kind)),
  }

  truncated.cpuDetail = plan.cpuDetailEnabled ? sample.cpuDetail : undefined
  truncated.memoryDetail = plan.memoryDetailEnabled ? sample.memoryDetail : undefined
  truncated.numaNodes = sample.numaNodes?.slice(0, plan.numaNodeSlots)

  // `cpuCoreLive` is live-only regardless of slot count: a live session with
  // zero slots gets nothing, and a baseline sample never carries per-core
  // live data even if the plan grants slots (slots only bound a live
  // session's array length, they don't turn on baseline emission).
  truncated.cpuCoreLive =
    sample.metadata.collectionMode === 'live'
      ? sample.cpuCoreLive?.slice(0, plan.cpuLiveCoreSlots)
      : undefined

  return truncated
}
