/**
 * Metrics capability plan (v5) — backend-neutral entitlement model for how
 * much of the v5 metrics contract (`contract-v5.ts`) a given server is
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
 * {@link truncateSampleToCapabilityPlanV5} on the incoming `MetricsSampleV5`,
 * then hands the truncated sample to the store.
 */

import { isHardwareHealthEventKindV5, type MetricsSampleV5 } from './contract-v5.ts'
import { MAX_NIC_SLOTS, type SlotMapping } from '../../client/servers/topology-types.ts'

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export type MetricsCapabilityPlanV5 = {
  /** Steady-state sampling cadence, seconds. */
  baselineIntervalSeconds: number
  /** Fastest cadence a "live" on-demand session may request, seconds. */
  liveMinIntervalSeconds: number
  /** Monitored normal-NIC slots a server may store (`SlotMapping.normalNicSlots` is truncated to this at ingest); never above `MAX_NIC_SLOTS`. */
  normalNicSlots: number
  /** Whether TurboFabric mesh interfaces may report beyond the normal NIC slots. */
  turboFabricEnabled: boolean
  /** Additional `filesystems` entries allowed beyond root-filesystem host metrics. */
  extraFilesystemSlots: number
  /** `blockDevices` entries allowed (per-disk service devices; 0 = none). */
  detailedBlockDeviceSlots: number
  /** `gpus` entries allowed. */
  gpuSlots: number
  /** Whether GPU interconnect (NVLink/etc) signals may be reported. */
  gpuInterconnectEnabled: boolean
  /** `hardwareSignals` entries allowed (fans/voltages/PSU/etc). */
  physicalHardwareSignalSlots: number
  /** Whether `cpuDetail` (host-wide frequency/scheduling counters) may be reported. */
  cpuDetailEnabled: boolean
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
  'memoryDetailEnabled',
  'numaNodeSlots',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlanV5)[]

/**
 * Per-server machine classification driving {@link platformDefaultMetricsCapabilityPlan}.
 * Not derived from any stored field yet — the caller (later phase: ingest,
 * once server topology/hardware detection is wired) is responsible for
 * classifying the reporting server. The declared `server.machine_class`
 * column is authoritative; {@link resolveServerMachineClass} holds the only
 * fallback (topology inference), and it applies solely while that column is
 * NULL — never as a silent default that would recreate the "every server
 * gets the same plan" bug this type exists to fix.
 */
export type ServerMachineClass = 'physical' | 'virtual'

export function isServerMachineClass(value: unknown): value is ServerMachineClass {
  return value === 'physical' || value === 'virtual'
}

/**
 * Infer a machine class from whichever topology snapshot is on hand (the
 * daemon's `topology-report.snapshot`, stored verbatim by
 * `recordTopologyGeneration`): a physical host is the only kind that ever
 * discovers host-level sensors, so a non-empty `hardwareSignals` array is
 * proof of `'physical'`; an empty one is only absence of proof and resolves
 * `'virtual'`. A snapshot that lacks the array entirely (none recorded, or a
 * minimal test snapshot) falls through to `sampleSignalCount` — the raw,
 * pre-truncation sample's own signal count at ingest, `0` on the read side
 * where there is no sample.
 */
export function inferServerMachineClass(
  topologySnapshot: unknown,
  sampleSignalCount = 0
): ServerMachineClass {
  if (
    typeof topologySnapshot === 'object' &&
    topologySnapshot !== null &&
    !Array.isArray(topologySnapshot)
  ) {
    const signals = (topologySnapshot as Record<string, unknown>).hardwareSignals
    if (Array.isArray(signals)) return signals.length > 0 ? 'physical' : 'virtual'
  }
  return sampleSignalCount > 0 ? 'physical' : 'virtual'
}

/**
 * The one machine-class resolution both ingest and the read-side routes use,
 * so the plan a sample is truncated to and the limits the UI reports never
 * disagree. The declared `server.machine_class` column wins outright — an
 * operator can pin a VM that exposes a bogus thermal zone to `'virtual'`, or
 * a physical box whose sensors are not exposed to `'physical'`. Only while
 * the column is NULL does {@link inferServerMachineClass} run.
 */
export function resolveServerMachineClass(
  declared: unknown,
  topologySnapshot: unknown,
  sampleSignalCount = 0
): ServerMachineClass {
  if (isServerMachineClass(declared)) return declared
  return inferServerMachineClass(topologySnapshot, sampleSignalCount)
}

/**
 * Which deployment resolves the plan: the hosted platform (Cloudflare
 * Workers — every server gets the platform default until licensing tiers
 * arrive) or a self-hosted instance (Deno), which is not metered and gets the
 * self-hosted ceiling instead. Derived from the runtime by
 * {@link metricsDeploymentKindForRuntime}; never inferred from globals, so a
 * test running under Deno still exercises hosted behavior unless it asks
 * for the other.
 */
export type MetricsDeploymentKind = 'hosted' | 'self-hosted'

export function metricsDeploymentKindForRuntime(
  runtime: 'workers' | 'deno'
): MetricsDeploymentKind {
  return runtime === 'workers' ? 'hosted' : 'self-hosted'
}

/**
 * Self-hosted NIC-slot default — the ceiling itself (`MAX_NIC_SLOTS`): a
 * self-hosted instance is not metered, so an operator may monitor as many
 * physical uplinks as the topology offers, up to the hard cap.
 */
export const SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS = MAX_NIC_SLOTS

/**
 * Platform fallback applied when neither org nor server override a field —
 * the **hosted** baseline. `normalNicSlots` is the hosted default (2 — one
 * gateway NIC plus one extra; more will need a higher tier later) and
 * `physicalHardwareSignalSlots` reflects the `"physical"` baseline — use
 * {@link platformDefaultMetricsCapabilityPlan} (or
 * {@link resolveMetricsCapabilityPlan}) to get the per-machine-class,
 * per-deployment default, since a virtual machine has no host-level fan/
 * voltage/PSU/etc. sensors to report and a self-hosted instance is not
 * NIC-metered.
 */
export const PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN: MetricsCapabilityPlanV5 = {
  baselineIntervalSeconds: 60,
  liveMinIntervalSeconds: 10,
  normalNicSlots: 2,
  turboFabricEnabled: true,
  extraFilesystemSlots: 0,
  detailedBlockDeviceSlots: 2,
  gpuSlots: 1,
  gpuInterconnectEnabled: false,
  physicalHardwareSignalSlots: 19,
  cpuDetailEnabled: false,
  memoryDetailEnabled: false,
  numaNodeSlots: 0,
  managedIngressEnabled: true,
  databaseProxyMetricsEnabled: true,
  hardwareHealthEventsEnabled: true,
}

/**
 * Platform default plan for a given {@link ServerMachineClass} and
 * {@link MetricsDeploymentKind} — every field matches
 * {@link PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN} except
 * `physicalHardwareSignalSlots` (`19` only for `"physical"`, `0` for
 * `"virtual"`) and `normalNicSlots` (`SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS`
 * for a self-hosted instance).
 */
export function platformDefaultMetricsCapabilityPlan(
  machineClass: ServerMachineClass,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlanV5 {
  return {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    normalNicSlots:
      deployment === 'self-hosted'
        ? SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS
        : PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.normalNicSlots,
    physicalHardwareSignalSlots:
      machineClass === 'physical'
        ? PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.physicalHardwareSignalSlots
        : 0,
  }
}

/** Partial override layer — org-wide (`organization.options`) or per-server (`server.options`). */
export type MetricsCapabilityPlanOverrideV5 = Partial<MetricsCapabilityPlanV5>

const POSITIVE_INT_FIELDS = [
  'baselineIntervalSeconds',
  'liveMinIntervalSeconds',
] as const satisfies readonly (keyof MetricsCapabilityPlanV5)[]

const NON_NEGATIVE_INT_FIELDS = [
  'normalNicSlots',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'physicalHardwareSignalSlots',
  'numaNodeSlots',
] as const satisfies readonly (keyof MetricsCapabilityPlanV5)[]

const BOOLEAN_FIELDS = [
  'turboFabricEnabled',
  'gpuInterconnectEnabled',
  'cpuDetailEnabled',
  'memoryDetailEnabled',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlanV5)[]

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
): MetricsCapabilityPlanOverrideV5 {
  if (!isRecord(value)) return {}
  const override: MetricsCapabilityPlanOverrideV5 = {}
  for (const key of POSITIVE_INT_FIELDS) {
    if (isPositiveInteger(value[key])) override[key] = value[key] as number
  }
  for (const key of NON_NEGATIVE_INT_FIELDS) {
    if (isNonNegativeInteger(value[key])) override[key] = value[key] as number
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof value[key] === 'boolean') override[key] = value[key] as boolean
  }
  // The slot-mapping layer, the daemon, and the UI all stop at MAX_NIC_SLOTS
  // — an override above it would promise slots nothing can fill.
  if (override.normalNicSlots !== undefined && override.normalNicSlots > MAX_NIC_SLOTS) {
    override.normalNicSlots = MAX_NIC_SLOTS
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
): MetricsCapabilityPlanOverrideV5 {
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
  orgOverride: MetricsCapabilityPlanOverrideV5 | undefined,
  serverOverride: MetricsCapabilityPlanOverrideV5 | undefined,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlanV5 {
  return {
    ...platformDefaultMetricsCapabilityPlan(machineClass, deployment),
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
  plan: MetricsCapabilityPlanV5
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
// Enforcement — truncate a discovered v5 sample down to plan entitlements.
// ---------------------------------------------------------------------------

/**
 * Truncate a `MetricsSampleV5`'s presence-gated entity arrays/optionals down
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
 *   (`isHardwareHealthEventKindV5`, `contract-v5.ts`) when
 *   `hardwareHealthEventsEnabled` is false; every other kind (OS/kernel,
 *   filesystem, fabric, clock-sync, topology/boot generation) is unrelated
 *   operational history and always survives.
 * - `networks` keeps, in slot order, the `slotMapping.normalNicSlots` devices
 *   within `normalNicSlots`, then every `fabricDeviceIds` device when
 *   `turboFabricEnabled` — anything else the daemon sent (an unmonitored
 *   device, a slot beyond the plan) is dropped before it reaches a store.
 *   Without a resolved mapping (generation not recorded yet) the first
 *   `normalNicSlots` entries survive positionally, matching the packer's own
 *   positional fallback, and fabric devices cannot be told apart so nothing
 *   beyond that count is kept.
 */
/**
 * Conservative fallback plan resolution — platform defaults only, always
 * `"virtual"` machine class (no host-level hardware-signal slots granted).
 * Ingest (`api-routes.ts`) uses `resolveEffectiveMetricsCapabilityPlan`
 * (`server-metadata.ts`) for the real, persisted-state resolution and falls
 * back to this only when no DB is available for the request or the real
 * resolution itself fails — never as the default path.
 */
export function resolveDefaultMetricsCapabilityPlanV5(
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlanV5 {
  return resolveMetricsCapabilityPlan('virtual', undefined, undefined, deployment)
}

/**
 * `networks` truncation — see {@link truncateSampleToCapabilityPlanV5}'s doc
 * comment. Identity-addressed when a `slotMapping` is available (a device is
 * kept because of *which* device it is, never its array position), ordered
 * slots-first so the positional packer fallback still embeds slot 1/2.
 */
function truncateNetworksToPlanV5(
  networks: MetricsSampleV5['networks'],
  plan: MetricsCapabilityPlanV5,
  slotMapping: SlotMapping | undefined
): MetricsSampleV5['networks'] {
  if (!slotMapping) return networks.slice(0, plan.normalNicSlots)
  const byId = new Map(networks.map((device) => [device.deviceId, device]))
  const keepIds = [
    ...slotMapping.normalNicSlots.slice(0, plan.normalNicSlots),
    ...(plan.turboFabricEnabled ? slotMapping.fabricDeviceIds : []),
  ]
  const kept: MetricsSampleV5['networks'] = []
  for (const id of keepIds) {
    const device = byId.get(id)
    if (device && !kept.includes(device)) kept.push(device)
  }
  return kept
}

export function truncateSampleToCapabilityPlanV5(
  sample: MetricsSampleV5,
  plan: MetricsCapabilityPlanV5,
  slotMapping?: SlotMapping
): MetricsSampleV5 {
  const nonRootFilesystems = slotMapping?.rootFilesystemId
    ? sample.filesystems.filter((fs) => fs.filesystemId !== slotMapping.rootFilesystemId)
    : sample.filesystems
  const truncated: MetricsSampleV5 = {
    ...sample,
    networks: truncateNetworksToPlanV5(sample.networks, plan, slotMapping),
    gpus: sample.gpus.slice(0, plan.gpuSlots),
    blockDevices: sample.blockDevices.slice(0, plan.detailedBlockDeviceSlots),
    filesystems: nonRootFilesystems.slice(0, plan.extraFilesystemSlots),
    hardwareSignals: sample.hardwareSignals.slice(0, plan.physicalHardwareSignalSlots),
    ingressSources: plan.managedIngressEnabled ? sample.ingressSources : [],
    databaseProxies: plan.databaseProxyMetricsEnabled ? sample.databaseProxies : [],
    events: plan.hardwareHealthEventsEnabled
      ? sample.events
      : sample.events.filter((event) => !isHardwareHealthEventKindV5(event.kind)),
  }

  truncated.cpuDetail = plan.cpuDetailEnabled ? sample.cpuDetail : undefined
  truncated.memoryDetail = plan.memoryDetailEnabled ? sample.memoryDetail : undefined
  truncated.numaNodes = sample.numaNodes?.slice(0, plan.numaNodeSlots)

  return truncated
}
