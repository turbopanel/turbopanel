/**
 * Metrics capability plan (v5) — backend-neutral entitlement model for how
 * much of the v5 metrics contract (`contract.ts`) a given server is
 * allowed to report/store. Deliberately carries no pricing-tier names or
 * literals: this module only knows about slot counts and feature toggles,
 * never about what plan/SKU produced them. Org-wide defaults live in
 * `organization.options.metricsCapabilityPlan` (`../../lib/organization-options.ts`),
 * an optional per-server override lives in `server.options.metricsCapabilityPlan`
 * (read the same way `server-metadata.ts` reads `cpuTdpWattsOverride`), and
 * {@link resolveMetricsCapabilityPlan} layers (optional) tier-derived base
 * or platform default → org → server, mirroring
 * `resolveEffectiveCpuThermalLimits`. A hosted license with a `tier` row
 * supplies the base via {@link metricsCapabilityPlanFromTierEntitlements};
 * self-hosted and unlicensed seats keep the platform default.
 *
 * Ingest call site: `POST /api/daemon/v1/metrics` (`api-routes.ts`) resolves
 * the effective plan for the reporting server via
 * `resolveEffectiveMetricsCapabilityPlan` (`server-metadata.ts`). Hosted
 * ingest then calls {@link truncateSampleToCapabilityPlan}; self-hosted
 * ingest skips truncation and writes the validated sample unchanged.
 */

import { isHardwareHealthEventKind, type MetricsSample } from './contract.ts'
import { METRICS_LIVE_INTERVAL_SECONDS } from './types.ts'
import { MAX_NIC_SLOTS, type SlotMapping } from '../../client/servers/topology-types.ts'

/**
 * Steady collection cadence, seconds. Matches the daemon's `METRICS_INTERVAL_MS`.
 */
export const METRICS_BASELINE_INTERVAL_SECONDS = 60

/**
 * Phase-jitter bound, seconds. Matches the daemon's `METRICS_JITTER_MAX_MS`.
 * Jitter does not change cadence; this is the slack a legitimate baseline
 * reading can sit below 60 s after a delayed tick.
 */
export const METRICS_BASELINE_JITTER_MAX_SECONDS = 5

/**
 * Primed first-delta sample delay, seconds. Matches the daemon's
 * `METRICS_PRIME_MS`. A 2 s (+ jitter) interval is a real baseline reading
 * and must still persist; it is not a 10 s live sample.
 */
export const METRICS_PRIME_INTERVAL_SECONDS = 2

/**
 * True when `intervalSeconds` looks like a 10 s live-cadence sample rather
 * than a baseline tick (60 s ± jitter) or the attach-time primed delta
 * (2 s + jitter). Used as the ingest backstop that refuses a durable write
 * when the live-session marker is missing — never as the primary live-routing
 * mechanism.
 */
export function isUnmarkedLiveCadenceInterval(intervalSeconds: number): boolean {
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return false
  const baselineFloor = METRICS_BASELINE_INTERVAL_SECONDS - METRICS_BASELINE_JITTER_MAX_SECONDS
  if (intervalSeconds >= baselineFloor) return false
  const primingCeiling = METRICS_PRIME_INTERVAL_SECONDS + METRICS_BASELINE_JITTER_MAX_SECONDS
  if (intervalSeconds <= primingCeiling) return false
  return intervalSeconds <= METRICS_LIVE_INTERVAL_SECONDS + METRICS_BASELINE_JITTER_MAX_SECONDS
}

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export type MetricsCapabilityPlan = {
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
  /** Whether `ingressSources` may be reported. */
  managedIngressEnabled: boolean
  /** Whether `databaseProxies` may be reported. */
  databaseProxyMetricsEnabled: boolean
  /**
   * Whether `dockerUsage` — Docker's own `GET /system/df` breakdown — may be
   * reported. `storage` has no flag of its own: host-wide storage accounting
   * is granted at every tier, the same way `diagnostics` needed no flag once
   * v6 merged it.
   */
  managedDockerEnabled: boolean
  /** Whether hardware-health `events` may be reported. */
  hardwareHealthEventsEnabled: boolean
}

/** Field order used for canonical serialization ({@link computeMetricsCapabilityPlanHash}). */
const METRICS_CAPABILITY_PLAN_FIELD_ORDER = [
  'liveMinIntervalSeconds',
  'normalNicSlots',
  'turboFabricEnabled',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'gpuInterconnectEnabled',
  'physicalHardwareSignalSlots',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'managedDockerEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlan)[]

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
 * `recordTopologyGeneration`). A v6 daemon states its own verdict in
 * `snapshot.machineClass` (DMI-based, `physical-classifier.ts`), and that
 * wins: a bare-metal host with nothing discoverable is still physical.
 * Without it, the sensor proxy: a physical host is the only kind that ever
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
    const declaredByDaemon = (topologySnapshot as Record<string, unknown>).machineClass
    if (isServerMachineClass(declaredByDaemon)) return declaredByDaemon
    const signals = (topologySnapshot as Record<string, unknown>).hardwareSignals
    if (Array.isArray(signals)) {
      return signals.length > 0 ? 'physical' : 'virtual'
    }
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
 * Workers — every server gets the platform default unless a license tier
 * supplies entitlements) or a self-hosted instance (Deno), which is not
 * metered and gets the self-hosted ceiling instead. Derived from the runtime
 * by {@link metricsDeploymentKindForRuntime}; never inferred from globals, so
 * a test running under Deno still exercises hosted behavior unless it asks
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
export const PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN: MetricsCapabilityPlan = {
  liveMinIntervalSeconds: 10,
  normalNicSlots: 2,
  turboFabricEnabled: true,
  extraFilesystemSlots: 0,
  detailedBlockDeviceSlots: 2,
  gpuSlots: 1,
  gpuInterconnectEnabled: false,
  physicalHardwareSignalSlots: 19,
  managedIngressEnabled: true,
  databaseProxyMetricsEnabled: true,
  // Permissive when no license tier is bound. A bound entry-tier row turns
  // this off via {@link metricsCapabilityPlanFromTierEntitlements}.
  managedDockerEnabled: true,
  hardwareHealthEventsEnabled: true,
}

/**
 * Host-level hardware-signal slots granted to a physical machine on the
 * entry tier. Callers pass {@link MetricsCapabilityTierEntitlements.isEntryTier}
 * rather than a label so this module never names a priced SKU.
 */
const ENTRY_TIER_PHYSICAL_HARDWARE_SIGNAL_SLOTS = 11

/**
 * Already-resolved numeric entitlements from a `tier` row. The caller
 * computes `isEntryTier` from `rank` (entry = rank 1) so this module stays
 * free of priced-offering labels.
 */
export type MetricsCapabilityTierEntitlements = {
  nicSlots: number
  driveSlots: number
  gpuSlots: number
  filesystemSlots: number
  isEntryTier: boolean
}

/**
 * Map a tier's raw entitlement columns onto {@link MetricsCapabilityPlan}.
 * Unspecified fields (cadence, interconnect, ingress, proxy, health events)
 * keep the platform default. `physicalHardwareSignalSlots` is still zeroed
 * for virtual machines; the entry-tier carve-out only applies to physical
 * hosts. `managedDockerEnabled` is off on the entry tier.
 */
export function metricsCapabilityPlanFromTierEntitlements(
  entitlements: MetricsCapabilityTierEntitlements,
  machineClass: ServerMachineClass,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  const base = platformDefaultMetricsCapabilityPlan(machineClass, deployment)
  const normalNicSlots = Math.min(Math.max(entitlements.nicSlots, 0), MAX_NIC_SLOTS)
  const extraFilesystemSlots = entitlements.isEntryTier ? 0 : entitlements.filesystemSlots
  let physicalHardwareSignalSlots = 0
  if (machineClass === 'physical') {
    physicalHardwareSignalSlots = entitlements.isEntryTier
      ? ENTRY_TIER_PHYSICAL_HARDWARE_SIGNAL_SLOTS
      : base.physicalHardwareSignalSlots
  }
  return {
    ...base,
    normalNicSlots,
    extraFilesystemSlots,
    detailedBlockDeviceSlots: entitlements.driveSlots,
    gpuSlots: entitlements.gpuSlots,
    physicalHardwareSignalSlots,
    managedDockerEnabled: !entitlements.isEntryTier,
  }
}

/**
 * Resolve a plan from already-mapped tier entitlements (no org/server
 * override layer). Prefer {@link resolveMetricsCapabilityPlan} at call sites
 * that also have jsonb overrides.
 */
export function resolveTierMetricsCapabilityPlan(
  entitlements: MetricsCapabilityTierEntitlements,
  machineClass: ServerMachineClass,
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  return metricsCapabilityPlanFromTierEntitlements(entitlements, machineClass, deployment)
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
): MetricsCapabilityPlan {
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
export type MetricsCapabilityPlanOverride = Partial<MetricsCapabilityPlan>

const POSITIVE_INT_FIELDS = [
  'liveMinIntervalSeconds',
] as const satisfies readonly (keyof MetricsCapabilityPlan)[]

const NON_NEGATIVE_INT_FIELDS = [
  'normalNicSlots',
  'extraFilesystemSlots',
  'detailedBlockDeviceSlots',
  'gpuSlots',
  'physicalHardwareSignalSlots',
] as const satisfies readonly (keyof MetricsCapabilityPlan)[]

const BOOLEAN_FIELDS = [
  'turboFabricEnabled',
  'gpuInterconnectEnabled',
  'managedIngressEnabled',
  'databaseProxyMetricsEnabled',
  'managedDockerEnabled',
  'hardwareHealthEventsEnabled',
] as const satisfies readonly (keyof MetricsCapabilityPlan)[]

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
export function parseMetricsCapabilityPlanOverride(value: unknown): MetricsCapabilityPlanOverride {
  if (!isRecord(value)) return {}
  const override: MetricsCapabilityPlanOverride = {}
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
): MetricsCapabilityPlanOverride {
  return parseMetricsCapabilityPlanOverride(value)
}

/**
 * Strict parse of a full persisted/pushed {@link MetricsCapabilityPlan}.
 * Every field must be present and valid — a partial override is not a plan.
 */
export function parseMetricsCapabilityPlan(value: unknown): MetricsCapabilityPlan | undefined {
  const override = parseMetricsCapabilityPlanOverride(value)
  for (const key of METRICS_CAPABILITY_PLAN_FIELD_ORDER) {
    if (override[key] === undefined) return undefined
  }
  return override as MetricsCapabilityPlan
}

/**
 * Resolve the effective plan: (optional) tier-derived base or per-machine-class
 * platform default → org override → server override, field by field (a later
 * layer only wins for fields it actually sets —
 * {@link parseMetricsCapabilityPlanOverride} never emits a key it couldn't
 * validate, so partial layers compose safely).
 *
 * When `tierEntitlements` is present it replaces
 * {@link platformDefaultMetricsCapabilityPlan} as the base; org/server
 * overrides still win on top. Absent entitlements (self-hosted, or a license
 * without a tier) preserve the historical platform-default path.
 *
 * `machineClass` is required (not defaulted) so a virtual server can never
 * silently inherit the physical `physicalHardwareSignalSlots` baseline — see
 * {@link platformDefaultMetricsCapabilityPlan}. An explicit org/server
 * override for that field still wins over the machine-class default, same as
 * any other field.
 */
export function resolveMetricsCapabilityPlan(
  machineClass: ServerMachineClass,
  orgOverride: MetricsCapabilityPlanOverride | undefined,
  serverOverride: MetricsCapabilityPlanOverride | undefined,
  deployment: MetricsDeploymentKind,
  tierEntitlements?: MetricsCapabilityTierEntitlements
): MetricsCapabilityPlan {
  const base = tierEntitlements
    ? metricsCapabilityPlanFromTierEntitlements(tierEntitlements, machineClass, deployment)
    : platformDefaultMetricsCapabilityPlan(machineClass, deployment)
  return {
    ...base,
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
  plan: MetricsCapabilityPlan
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
 * Truncate a `MetricsSample`'s presence-gated entity arrays/optionals down
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
 *   (`isHardwareHealthEventKind`, `contract.ts`) when
 *   `hardwareHealthEventsEnabled` is false; every other kind (OS/kernel,
 *   filesystem, fabric, clock-sync, topology/boot generation) is unrelated
 *   operational history and always survives.
 * - `router` rides `managedIngressEnabled`, the same entitlement that gates
 *   `ingressSources`: both are traffic visibility for the host's HTTP
 *   front door, and splitting Traefik out of `managed.ingress` into its own
 *   family was a storage-layout change, not a new thing to sell. Dropped by
 *   omitting the key entirely (never an `undefined`-valued property), the
 *   same idiom `buildMetricsSample` uses to build it.
 * - `dockerUsage` rides `managedDockerEnabled` — Docker's `/system/df`
 *   breakdown is a managed-container feature, not universal host accounting.
 *   Dropped by omitting the key entirely (never an `undefined`-valued
 *   property), the same idiom `router` uses.
 * - `storage` is deliberately ungated and passes through untouched, exactly
 *   like `diagnostics`: a host always knows where its own bytes went, and the
 *   row it costs is one row on every tier.
 * - `diagnostics` is deliberately absent: v6 merged the two capability-gated
 *   detail families into one always-on `host.diagnostics` row, so the depth
 *   metrics pass through untouched by the `...sample` spread. Doubles inside
 *   an AE row are free — the row is the cost — so there is nothing left for a
 *   plan to buy here.
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
export function resolveDefaultMetricsCapabilityPlan(
  deployment: MetricsDeploymentKind
): MetricsCapabilityPlan {
  return resolveMetricsCapabilityPlan('virtual', undefined, undefined, deployment)
}

/**
 * `networks` truncation — see {@link truncateSampleToCapabilityPlan}'s doc
 * comment. Identity-addressed when a `slotMapping` is available (a device is
 * kept because of *which* device it is, never its array position), ordered
 * slots-first so the positional packer fallback still embeds slot 1/2.
 */
function truncateNetworksToPlan(
  networks: MetricsSample['networks'],
  plan: MetricsCapabilityPlan,
  slotMapping: SlotMapping | undefined
): MetricsSample['networks'] {
  if (!slotMapping) return networks.slice(0, plan.normalNicSlots)
  const byId = new Map(networks.map((device) => [device.deviceId, device]))
  const keepIds = [
    ...slotMapping.normalNicSlots.slice(0, plan.normalNicSlots),
    ...(plan.turboFabricEnabled ? slotMapping.fabricDeviceIds : []),
  ]
  const kept: MetricsSample['networks'] = []
  for (const id of keepIds) {
    const device = byId.get(id)
    if (device && !kept.includes(device)) kept.push(device)
  }
  return kept
}

export function truncateSampleToCapabilityPlan(
  sample: MetricsSample,
  plan: MetricsCapabilityPlan,
  slotMapping?: SlotMapping
): MetricsSample {
  const nonRootFilesystems = slotMapping?.rootFilesystemId
    ? sample.filesystems.filter((fs) => fs.filesystemId !== slotMapping.rootFilesystemId)
    : sample.filesystems
  // `router` is dropped by omitting the key, never by assigning `undefined`:
  // the field is optional on `MetricsSample`, and a present-but-undefined
  // property is a different object shape than an absent one (which whole-
  // sample equality assertions and `JSON.stringify` both notice).
  const { router: _gatedRouter, ...withoutRouter } = sample
  const base = plan.managedIngressEnabled ? sample : withoutRouter
  // Same omit-the-key discipline for `dockerUsage`, applied to whatever
  // `router` already left behind so the two gates compose.
  const { dockerUsage: _gatedDockerUsage, ...withoutDockerUsage } = base
  const gated = plan.managedDockerEnabled ? base : withoutDockerUsage
  const truncated: MetricsSample = {
    ...gated,
    networks: truncateNetworksToPlan(sample.networks, plan, slotMapping),
    gpus: sample.gpus.slice(0, plan.gpuSlots),
    blockDevices: sample.blockDevices.slice(0, plan.detailedBlockDeviceSlots),
    filesystems: nonRootFilesystems.slice(0, plan.extraFilesystemSlots),
    hardwareSignals: sample.hardwareSignals.slice(0, plan.physicalHardwareSignalSlots),
    ingressSources: plan.managedIngressEnabled ? sample.ingressSources : [],
    databaseProxies: plan.databaseProxyMetricsEnabled ? sample.databaseProxies : [],
    events: plan.hardwareHealthEventsEnabled
      ? sample.events
      : sample.events.filter((event) => !isHardwareHealthEventKind(event.kind)),
  }

  return truncated
}
