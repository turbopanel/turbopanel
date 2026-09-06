import {
  parseServerIps,
  serverIpsEquals,
  type ServerReportedIp,
} from "../../server-addresses.ts";
import type { ServerGeo } from "../geo/server-geo.ts";
import type { DatacenterOptions } from "../datacenter-options.ts";
import {
  type NtpDefaults,
  parseNtpDefaults,
  parseSshPort,
} from "../host-defaults.ts";
import type { OrganizationOptions } from "../organization-options.ts";
import {
  isExactCpuCatalogMatch,
  resolveCpuCatalogEntry,
} from "../hardware/cpu-catalog.ts";
import {
  type MetricsCapabilityPlanOverrideV4,
  type MetricsCapabilityPlanV4,
  type MetricsDeploymentKind,
  parseServerMetricsCapabilityPlanOverride,
  resolveMetricsCapabilityPlan,
  type ServerMachineClass,
} from "../../daemon/metrics/capability-plan.ts";

/** OS families we may report from the daemon; extend the union as support is added. */
export type ServerOsFamily = "linux" | "windows" | "freebsd" | "darwin";

/**
 * Distro variant beyond raw `ID=` — Raspberry Pi OS 64-bit still reports
 * `ID=debian` but the daemon sets this when `/etc/rpi-issue` is present.
 */
export type ServerOsVariant = "raspberry-pi-os";

/** Best-effort OS block; fields may be filled in over time. */
export type ServerOsMetadata = {
  family?: ServerOsFamily;
  /** Distro id from os-release `ID=` (e.g. `"debian"`, `"raspbian"`). */
  id?: string;
  /**
   * Product variant when `ID` alone is misleading (e.g. Raspberry Pi OS 64-bit).
   */
  variant?: ServerOsVariant;
  /** Prefer dotted point-release (`"13.5"`) over bare major (`"13"`). */
  version?: string;
  /** e.g. `VERSION_CODENAME` `"trixie"` */
  codename?: string;
  /** Raw `PRETTY_NAME` from os-release when available. */
  prettyName?: string;
  /** e.g. arm64, x86_64, aarch64 */
  architecture?: string;
};

/** Physical vs efficiency core/thread counts on hybrid CPUs. */
export type ServerCpuCoreSplit = {
  total: number;
  /** Performance / P-cores (Intel) or big cores. */
  p?: number;
  /** Efficiency / E-cores (Intel) or little cores. */
  e?: number;
};

/** Cache sizes in bytes. `l1` is `l1d + l1i` when both splits are known. */
export type ServerCpuCache = {
  l1?: number;
  l1d?: number;
  l1i?: number;
  l2?: number;
  l3?: number;
  l4?: number;
};

/** One physical CPU socket (`resources.cpus[0]`, `cpus[1]`, …). */
export type ServerCpuSocket = {
  /** cpuinfo `vendor_id` (e.g. GenuineIntel) or ARM `CPU implementer`. */
  vendorId?: string;
  name?: string;
  architecture?: string;
  cores?: ServerCpuCoreSplit;
  threads?: ServerCpuCoreSplit;
  cache?: ServerCpuCache;
  /** Advertised base clock, MHz. */
  speedMhz?: number;
  /** Max turbo, MHz. */
  turboMhz?: number;
};

export type ServerGpu = {
  /** PCI vendor id from sysfs (e.g. `0x10de`). */
  vendorId?: string;
  name?: string;
  memoryBytes?: number;
  driver?: string;
  /** `vendor:device` without `0x` (e.g. `10de:2d04`). */
  pciId?: string;
  pciSlot?: string;
};

/**
 * Static host capacity from daemon hello (`/proc/cpuinfo` + `/proc/stat` +
 * `/proc/meminfo` + DRM). Used for fleet inventory totals and load-average
 * normalization — not live usage (that lives in the metrics backend).
 */
export type ServerHostResources = {
  /** One entry per physical socket, ordered 0, 1, … */
  cpus?: ServerCpuSocket[];
  gpus?: ServerGpu[];
  memory?: { totalBytes?: number };
  swap?: { totalBytes?: number };
  /** Host interface addresses (hello / change-detected heartbeat). */
  ips?: ServerReportedIp[];
};

/**
 * Cell placement / generation facts nested under `server.metadata.cell`.
 * Operator overrides for location/generation live on `server.options`.
 */
export type ServerCellMetadata = {
  /** Cloudflare `locationHint` chosen at enrollment (e.g. `"wnam"`, `"eeur"`). */
  locationHint?: string;
  /** Monotonically increasing; increment when a new DO logical name is issued. */
  generation?: number;
  /** Last snapshot version written by the cell, for optimistic concurrency. */
  snapshotVersion?: number;
};

/**
 * Host time-sync facts from the daemon wire (`HostTimeSync`). Persisted on
 * dedicated `server` columns (`timezone`, `is_time_sync_enabled`,
 * `ntp_servers`, `ntp_last_synced_at`) and composed back for the API.
 */
export type ServerTimeSync = {
  timezone?: string;
  ntpEnabled?: boolean;
  ntpSynced?: boolean;
  ntpServers?: string[];
  fallbackNtpServers?: string[];
  /** Last successful NTP sync (ISO). */
  lastSyncedAt?: string;
};

/** One configured NTP host stored in `server.ntp_servers` jsonb. */
export type ServerNtpServerEntry = {
  host: string;
  fallback?: true;
};

export const RASPBERRY_PI_OS_ID = "raspberry-pi-os";

export type ServerOsColumns = {
  osId: string | null;
  osFamily: string | null;
  osVersion: string | null;
  osCodename: string | null;
  osPrettyName: string | null;
  osArchitecture: string | null;
};

export type ServerTimeSyncColumns = {
  timezone: string | null;
  isTimeSyncEnabled: boolean | null;
  ntpServers: unknown;
  ntpLastSyncedAt: string | null;
};

/**
 * Host Docker CLI / Compose plugin versions from daemon hello / change-detected
 * heartbeat. Omit the whole object when Docker is not installed — do not store
 * an empty `{ }` placeholder.
 */
export type ServerDockerMetadata = {
  /** Docker CLI version (`docker --version`), e.g. `"28.3.3"`. */
  version?: string;
  /** Compose plugin version (`docker compose version`), e.g. `"2.39.1"`. */
  composeVersion?: string;
};

/**
 * Stable sensor identity for one hardware-profile slot — `chip` + `label`
 * from the daemon's `sensorId()` pair (see `turbopaneld` sensor discovery),
 * never a raw sysfs path. Paths (`hwmonN`) reindex across reboots; this
 * identity is what survives them.
 */
export type ServerSensorSlotAssignment = {
  chip: string;
  label: string;
};

/**
 * One hardware-profile slot: `undefined` (key absent) = never configured,
 * daemon auto-detects; `null` = explicitly unassigned (operator confirmed no
 * sensor here, suppress auto-detection); an assignment = pinned identity.
 */
export type ServerSensorSlot = ServerSensorSlotAssignment | null;

/**
 * Operator-assigned hardware profile nested under
 * `server.metadata.hardwareProfile`. The server row is the source of truth;
 * the daemon-side state files are a cache refreshed by the
 * `topology-overrides-update` cell push. `generation` bumps only when
 * a sensor-slot, NIC, or topology-id identity actually changes — it stamps
 * samples (`hardwareProfileGeneration`) so later chart segmentation can tell
 * layout changes apart from a plain value shift.
 * `nicSlotDeviceIds` / `hostingFilesystemId` hold
 * daemon-derived stable topology device/filesystem ids, distinct from the
 * raw interface name / path carried by `nic1` / `nic2` / `hostingPath`.
 */
export type ServerHardwareProfile = {
  /** CPU temperature sensor (RAPL / hwmon coretemp / thermal zone). */
  cpuTemperature?: ServerSensorSlot;
  /** CPU power sensor (RAPL energy counter). */
  cpuPower?: ServerSensorSlot;
  /** Which GPU device (of possibly several) feeds gpu temp/power/util/fan. */
  gpuDevice?: ServerSensorSlot;
  /**
   * Overrides the fan candidate `gpuDevice`'s fan-out otherwise selects —
   * only needed when a GPU's fan tachometer isn't discoverable from the same
   * device identity as its temperature/power.
   */
  gpuFan?: ServerSensorSlot;
  disk1Temperature?: ServerSensorSlot;
  disk2Temperature?: ServerSensorSlot;
  ambient1Temperature?: ServerSensorSlot;
  ambient2Temperature?: ServerSensorSlot;
  boardTemperature?: ServerSensorSlot;
  cpuFan?: ServerSensorSlot;
  systemFan1?: ServerSensorSlot;
  systemFan2?: ServerSensorSlot;
  /** Network interface name bound to the `nic1*` metric slot, or `null` when unassigned. */
  nic1?: string | null;
  /** Network interface name bound to the `nic2*` metric slot, or `null` when unassigned. */
  nic2?: string | null;
  /**
   * The operator's monitored-NIC list in slot order (slot 1 first): opaque,
   * daemon-derived topology device ids, never interface names (see
   * {@link ServerHardwareProfile.nic1}). Absent or empty means "auto" — only
   * the default-route uplink is monitored. Deduplicated; the slot-mapping
   * layer caps it at `MAX_NIC_SLOTS` and the effective capability plan's
   * `normalNicSlots` bounds what actually gets stored.
   */
  nicSlotDeviceIds?: string[];
  /** Absolute path of the filesystem probed as hosting storage. */
  hostingPath?: string;
  /**
   * Stable topology filesystem id for the hosting-storage filesystem, or
   * `null` when unassigned. Opaque, daemon-derived — not a path (see
   * {@link ServerHardwareProfile.hostingPath}).
   */
  hostingFilesystemId?: string | null;
  /**
   * Whether the daemon may probe per-drive temperatures (`drivetemp`
   * hwmon). Off by default — spinning up drives to read a sensor is
   * intrusive enough that it needs an explicit operator opt-in.
   */
  drivetempEnabled?: boolean;
  /** Monotonically increasing; bumps only when a sensor/NIC identity changes. */
  generation?: number;
  /** ISO timestamp of the last `generation` bump. */
  generationAppliedAt?: string;
  /**
   * Detected CPU model string (e.g. `"Intel Xeon Gold 6338"`), reported by
   * the daemon's host-facts projection — never operator-editable through the
   * hardware-profile PUT. Feeds {@link resolveEffectiveCpuThermalLimits} via
   * `resolveCpuCatalogEntry` (`../hardware/cpu-catalog.ts`) when no override
   * is set. Identity-bearing in name only — it never participates in
   * `generation`, which tracks sensor/NIC layout, not CPU identity.
   */
  cpuModel?: string;
  /**
   * Operator override for CPU thermal design power (watts), independent of
   * `cpuTdpWattsOverride`'s sibling field below — either may be set alone.
   * `undefined` = no override (fall through to the catalog); never bumps
   * `generation`.
   */
  cpuTdpWattsOverride?: number | null;
  /**
   * Operator override for CPU junction temperature limit (°C). See
   * {@link ServerHardwareProfile.cpuTdpWattsOverride}.
   */
  cpuTjMaxCelsiusOverride?: number | null;
};

/**
 * JSON stored in `server.metadata`. Nested fields are optional.
 * Hostname / machineKey / OS / observed timezone / NTP live on dedicated
 * `server` columns (not here).
 */
export type ServerMetadata = {
  /**
   * Host capacity (`cpus` / `gpus` / RAM / swap) from daemon hello, plus
   * `ips` from hello / change-detected heartbeat.
   */
  resources?: ServerHostResources;
  /**
   * Cell placement / generation nested under `cell` (options overrides apply).
   */
  cell?: ServerCellMetadata;
  /**
   * IP geolocation captured from the connecting request (Cloudflare `request.cf`
   * on Workers; stub/null on self-hosted). Refreshed only when the daemon's
   * connecting IP changes. Stored in jsonb — no migration required.
   */
  geo?: ServerGeo;
  /**
   * Docker CLI / Compose plugin versions. Present only when the daemon
   * reports Docker installed; omitted (not `null`) when it is not.
   */
  docker?: ServerDockerMetadata;
  /**
   * Runtimes actually installed on the host (PHP series and their extensions,
   * vendored tenant Node, vendored lsphp), from daemon hello / change-detected
   * heartbeat.
   *
   * jsonb, so no migration. This is what lets deploy-prepare answer "is this
   * PHP series installable here?" *before* queueing, instead of the daemon
   * failing at apply time — which was wrong in both directions: it rejected a
   * series the host could have installed, and reported the failure at the worst
   * possible moment.
   */
  runtimes?: ServerRuntimeMetadata;
  /**
   * Operator-assigned hardware profile for host metrics (sensor/NIC slots,
   * hosting path, drivetemp opt-in, generation). jsonb, so no migration.
   */
  hardwareProfile?: ServerHardwareProfile;
};

/**
 * JSON stored in `server.options`. Operator-controlled server configuration;
 * cell fields here override the enrollment copies in `server.metadata.cell`
 * when both are present.
 */
export type ServerOptions = {
  /**
   * Cloudflare `locationHint` for the daemon cell (e.g. `"wnam"`, `"eeur"`).
   * Takes precedence over `server.metadata.cell.locationHint` when set.
   */
  cellLocationHint?: string;
  /**
   * Monotonically increasing cell generation for logical DO naming.
   * Takes precedence over `server.metadata.cell.generation` when set.
   */
  cellGeneration?: number;
  /**
   * Operator timezone override for this server. Effective timezone is this value
   * unless the org enforces its default (`enforceServerTimezone`).
   */
  timezone?: string;
  /**
   * Desired SSH listen port for this host. Omitted → inherit datacenter, then
   * organization, then platform default 22.
   */
  sshPort?: number;
  /** Desired NTP client settings for this host. Omitted → inherit parent layers. */
  ntp?: NtpDefaults;
  /**
   * Desired state for Docker-hosting provisioning; consumed by later phases to
   * choose self-heal vs report-only.
   */
  hosting?: { enabled: boolean };
  /**
   * Per-server override for the v4 metrics capability plan (see
   * `../../daemon/metrics/capability-plan.ts`). Wins over any org-wide
   * `organization.options.metricsCapabilityPlan` field it sets — see
   * {@link resolveEffectiveMetricsCapabilityPlan}.
   */
  metricsCapabilityPlan?: MetricsCapabilityPlanOverrideV4;
};

const OS_FAMILIES = new Set<ServerOsFamily>([
  "linux",
  "windows",
  "freebsd",
  "darwin",
]);

const OS_VARIANTS = new Set<ServerOsVariant>(["raspberry-pi-os"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parse a best-effort OS block from daemon hello / stored metadata. */
export function parseServerOsMetadata(
  value: unknown,
): ServerOsMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const familyRaw = optionalTrimmedString(value.family)?.toLowerCase();
  const family = familyRaw && OS_FAMILIES.has(familyRaw as ServerOsFamily)
    ? (familyRaw as ServerOsFamily)
    : undefined;

  const os: ServerOsMetadata = {};
  if (family) os.family = family;
  const id = optionalTrimmedString(value.id);
  if (id) os.id = id;
  const variantRaw = optionalTrimmedString(value.variant)?.toLowerCase();
  if (variantRaw && OS_VARIANTS.has(variantRaw as ServerOsVariant)) {
    os.variant = variantRaw as ServerOsVariant;
  }
  const version = optionalTrimmedString(value.version);
  if (version) os.version = version;
  const codename = optionalTrimmedString(value.codename);
  if (codename) os.codename = codename;
  const prettyName = optionalTrimmedString(value.prettyName);
  if (prettyName) os.prettyName = prettyName;
  const architecture = optionalTrimmedString(value.architecture);
  if (architecture) os.architecture = architecture;

  return Object.keys(os).length > 0 ? os : undefined;
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function optionalPositiveInt(value: unknown): number | undefined {
  const n = optionalNonNegativeInt(value);
  if (n === undefined || n <= 0) return undefined;
  return n;
}

/** Matches `MAX_HARDWARE_PROFILE_FIELD_CHARS` in `metrics-routes-helpers.ts`. */
const MAX_CPU_MODEL_CHARS = 512;

/** Generous ceiling — well above any real single-socket CPU's TDP. */
const CPU_TDP_WATTS_MAX = 1000;
/** Plausible silicon junction-temperature range. */
const CPU_TJ_MAX_CELSIUS_MIN = 40;
const CPU_TJ_MAX_CELSIUS_MAX = 130;

function optionalCpuTdpWatts(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value <= 0 || value > CPU_TDP_WATTS_MAX) return undefined;
  return value;
}

function optionalCpuTjMaxCelsius(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < CPU_TJ_MAX_CELSIUS_MIN || value > CPU_TJ_MAX_CELSIUS_MAX) {
    return undefined;
  }
  return value;
}

function parseCpuCoreSplit(value: unknown): ServerCpuCoreSplit | undefined {
  if (!isRecord(value)) return undefined;
  const total = optionalPositiveInt(value.total);
  if (total === undefined) return undefined;
  const split: ServerCpuCoreSplit = { total };
  const p = optionalPositiveInt(value.p);
  if (p !== undefined) split.p = p;
  const e = optionalPositiveInt(value.e);
  if (e !== undefined) split.e = e;
  return split;
}

function parseCpuCache(value: unknown): ServerCpuCache | undefined {
  if (!isRecord(value)) return undefined;
  const cache: ServerCpuCache = {};
  const l1 = optionalPositiveInt(value.l1);
  if (l1 !== undefined) cache.l1 = l1;
  const l1d = optionalPositiveInt(value.l1d);
  if (l1d !== undefined) cache.l1d = l1d;
  const l1i = optionalPositiveInt(value.l1i);
  if (l1i !== undefined) cache.l1i = l1i;
  const l2 = optionalPositiveInt(value.l2);
  if (l2 !== undefined) cache.l2 = l2;
  const l3 = optionalPositiveInt(value.l3);
  if (l3 !== undefined) cache.l3 = l3;
  const l4 = optionalPositiveInt(value.l4);
  if (l4 !== undefined) cache.l4 = l4;
  return Object.keys(cache).length > 0 ? cache : undefined;
}

function parseCpuSocket(value: unknown): ServerCpuSocket | undefined {
  if (!isRecord(value)) return undefined;
  const socket: ServerCpuSocket = {};
  const vendorId = optionalTrimmedString(value.vendorId);
  if (vendorId) socket.vendorId = vendorId;
  const name = optionalTrimmedString(value.name);
  if (name) socket.name = name;
  const architecture = optionalTrimmedString(value.architecture);
  if (architecture) socket.architecture = architecture;
  const cores = parseCpuCoreSplit(value.cores);
  if (cores) socket.cores = cores;
  const threads = parseCpuCoreSplit(value.threads);
  if (threads) socket.threads = threads;
  const cache = parseCpuCache(value.cache);
  if (cache) socket.cache = cache;
  const speedMhz = optionalPositiveInt(value.speedMhz);
  if (speedMhz !== undefined) socket.speedMhz = speedMhz;
  const turboMhz = optionalPositiveInt(value.turboMhz);
  if (turboMhz !== undefined) socket.turboMhz = turboMhz;
  return Object.keys(socket).length > 0 ? socket : undefined;
}

function parseCpuSockets(value: unknown): ServerCpuSocket[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sockets: ServerCpuSocket[] = [];
  for (const entry of value) {
    const socket = parseCpuSocket(entry);
    if (socket) sockets.push(socket);
  }
  return sockets.length > 0 ? sockets : undefined;
}

function parseHostCpus(
  value: Record<string, unknown>,
): ServerCpuSocket[] | undefined {
  return parseCpuSockets(value.cpus);
}

function parseGpu(value: unknown): ServerGpu | undefined {
  if (!isRecord(value)) return undefined;
  const gpu: ServerGpu = {};
  const vendorId = optionalTrimmedString(value.vendorId);
  if (vendorId) gpu.vendorId = vendorId;
  const name = optionalTrimmedString(value.name);
  if (name) gpu.name = name;
  const memoryBytes = optionalPositiveInt(value.memoryBytes);
  if (memoryBytes !== undefined) gpu.memoryBytes = memoryBytes;
  const driver = optionalTrimmedString(value.driver);
  if (driver) gpu.driver = driver;
  const pciId = optionalTrimmedString(value.pciId);
  if (pciId) gpu.pciId = pciId;
  const pciSlot = optionalTrimmedString(value.pciSlot);
  if (pciSlot) gpu.pciSlot = pciSlot;
  return Object.keys(gpu).length > 0 ? gpu : undefined;
}

function parseGpus(value: unknown): ServerGpu[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const gpus: ServerGpu[] = [];
  for (const entry of value) {
    const gpu = parseGpu(entry);
    if (gpu) gpus.push(gpu);
  }
  return gpus.length > 0 ? gpus : undefined;
}

function parseMemoryTotal(value: unknown): { totalBytes: number } | undefined {
  if (!isRecord(value)) return undefined;
  const totalBytes = optionalPositiveInt(value.totalBytes);
  if (totalBytes === undefined) return undefined;
  return { totalBytes };
}

function parseSwapTotal(value: unknown): { totalBytes: number } | undefined {
  if (!isRecord(value)) return undefined;
  const totalBytes = optionalNonNegativeInt(value.totalBytes);
  // 0 is a valid SwapTotal (no swap).
  if (totalBytes === undefined) return undefined;
  return { totalBytes };
}

/** Parse host capacity block from daemon hello / stored metadata. */
export function parseServerHostResources(
  value: unknown,
): ServerHostResources | undefined {
  if (!isRecord(value)) return undefined;
  const resources: ServerHostResources = {};
  const cpus = parseHostCpus(value);
  if (cpus) resources.cpus = cpus;
  const gpus = parseGpus(value.gpus);
  if (gpus) resources.gpus = gpus;
  const memory = parseMemoryTotal(value.memory);
  if (memory) resources.memory = memory;
  const swap = parseSwapTotal(value.swap);
  if (swap) resources.swap = swap;
  const ips = parseServerIps(value.ips);
  if (ips !== undefined) resources.ips = ips;
  return Object.keys(resources).length > 0 ? resources : undefined;
}

/**
 * Overlay incoming host-resource keys onto the stored block. Heartbeat
 * `{ ips }` must not drop hello-only cpus / gpus / memory / swap.
 */
export function mergeServerHostResources(
  current: ServerHostResources | undefined,
  incoming: ServerHostResources,
): ServerHostResources {
  const next: ServerHostResources = { ...current };
  if (incoming.cpus) next.cpus = incoming.cpus;
  if (incoming.gpus) next.gpus = incoming.gpus;
  if (incoming.memory) next.memory = incoming.memory;
  if (incoming.swap) next.swap = incoming.swap;
  if (incoming.ips !== undefined) next.ips = incoming.ips;
  return next;
}

/** Host capacity from daemon hello / change-detected heartbeat payloads. */
export function resourcesFromDaemonPresence(
  payload: unknown,
): ServerHostResources | undefined {
  if (!isRecord(payload)) return undefined;
  const resources = parseServerHostResources(payload.resources);
  return resources && Object.keys(resources).length > 0 ? resources : undefined;
}

function cpuCoreSplitEquals(
  a: ServerCpuCoreSplit | undefined,
  b: ServerCpuCoreSplit | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.total === b.total && a.p === b.p && a.e === b.e;
}

function cpuCacheEquals(
  a: ServerCpuCache | undefined,
  b: ServerCpuCache | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.l1 === b.l1 &&
    a.l1d === b.l1d &&
    a.l1i === b.l1i &&
    a.l2 === b.l2 &&
    a.l3 === b.l3 &&
    a.l4 === b.l4
  );
}

function cpuSocketEquals(a: ServerCpuSocket, b: ServerCpuSocket): boolean {
  return (
    a.vendorId === b.vendorId &&
    a.name === b.name &&
    a.architecture === b.architecture &&
    cpuCoreSplitEquals(a.cores, b.cores) &&
    cpuCoreSplitEquals(a.threads, b.threads) &&
    cpuCacheEquals(a.cache, b.cache) &&
    a.speedMhz === b.speedMhz &&
    a.turboMhz === b.turboMhz
  );
}

function cpuSocketsEquals(
  a: ServerCpuSocket[] | undefined,
  b: ServerCpuSocket[] | undefined,
): boolean {
  if (a === b) return true;
  if (a?.length !== b?.length) return false;
  return (a ?? []).every((left, i) => {
    const right = b?.[i];
    return Boolean(left && right && cpuSocketEquals(left, right));
  });
}

function gpuEquals(a: ServerGpu, b: ServerGpu): boolean {
  return (
    a.vendorId === b.vendorId &&
    a.name === b.name &&
    a.memoryBytes === b.memoryBytes &&
    a.driver === b.driver &&
    a.pciId === b.pciId &&
    a.pciSlot === b.pciSlot
  );
}

function gpusEquals(
  a: ServerGpu[] | undefined,
  b: ServerGpu[] | undefined,
): boolean {
  if (a === b) return true;
  if (a?.length !== b?.length) return false;
  return (a ?? []).every((left, i) => {
    const right = b?.[i];
    return Boolean(left && right && gpuEquals(left, right));
  });
}

export function serverHostResourcesEquals(
  a: ServerHostResources | null | undefined,
  b: ServerHostResources | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    cpuSocketsEquals(a.cpus, b.cpus) &&
    gpusEquals(a.gpus, b.gpus) &&
    a.memory?.totalBytes === b.memory?.totalBytes &&
    a.swap?.totalBytes === b.swap?.totalBytes &&
    serverIpsEquals(a.ips, b.ips)
  );
}

/** Parse nested `server.metadata.cell` block. */
export function parseServerCellMetadata(
  value: unknown,
): ServerCellMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const cell: ServerCellMetadata = {};
  const locationHint = optionalTrimmedString(value.locationHint);
  if (locationHint) cell.locationHint = locationHint;
  if (
    typeof value.generation === "number" && Number.isInteger(value.generation)
  ) {
    cell.generation = value.generation;
  }
  if (
    typeof value.snapshotVersion === "number" &&
    Number.isInteger(value.snapshotVersion)
  ) {
    cell.snapshotVersion = value.snapshotVersion;
  }
  return Object.keys(cell).length > 0 ? cell : undefined;
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function titleCasePhrase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(" ");
}

function isRaspberryPiOs(os: ServerOsMetadata): boolean {
  if (os.variant === "raspberry-pi-os") return true;
  const id = os.id?.toLowerCase();
  return id === RASPBERRY_PI_OS_ID || id === "raspbian" ||
    id === "raspberrypi" || id === "raspios";
}

/** Map a parsed OS block onto dedicated `server.os_*` columns. */
export function osColumnsFromMetadata(os: ServerOsMetadata): ServerOsColumns {
  const osId = isRaspberryPiOs(os) ? RASPBERRY_PI_OS_ID : (os.id ?? null);
  return {
    osId,
    osFamily: os.family ?? null,
    osVersion: os.version ?? null,
    osCodename: os.codename ?? null,
    osPrettyName: os.prettyName ?? null,
    osArchitecture: os.architecture ?? null,
  };
}

/** Dedicated columns first; legacy `metadata.os` when columns are unset. */
export function resolveServerOsForRead(
  row: ServerOsColumns,
  metadata: unknown,
): ServerOsMetadata | undefined {
  return (
    osMetadataFromColumns(row) ??
      parseServerOsMetadata(isRecord(metadata) ? metadata.os : undefined)
  );
}

/** Compose the API `os` object from dedicated columns. */
export function osMetadataFromColumns(
  row: ServerOsColumns,
): ServerOsMetadata | undefined {
  const os: ServerOsMetadata = {};
  const familyRaw = row.osFamily?.trim().toLowerCase();
  if (familyRaw && OS_FAMILIES.has(familyRaw as ServerOsFamily)) {
    os.family = familyRaw as ServerOsFamily;
  }
  const osId = optionalTrimmedString(row.osId);
  if (osId) {
    os.id = osId;
    if (osId === RASPBERRY_PI_OS_ID) os.variant = RASPBERRY_PI_OS_ID;
  }
  const version = optionalTrimmedString(row.osVersion);
  if (version) os.version = version;
  const codename = optionalTrimmedString(row.osCodename);
  if (codename) os.codename = codename;
  const prettyName = optionalTrimmedString(row.osPrettyName);
  if (prettyName) os.prettyName = prettyName;
  const architecture = optionalTrimmedString(row.osArchitecture);
  if (architecture) os.architecture = architecture;
  return Object.keys(os).length > 0 ? os : undefined;
}

export function osColumnsEqual(
  a: ServerOsColumns,
  b: ServerOsColumns,
): boolean {
  return (
    a.osId === b.osId &&
    a.osFamily === b.osFamily &&
    a.osVersion === b.osVersion &&
    a.osCodename === b.osCodename &&
    a.osPrettyName === b.osPrettyName &&
    a.osArchitecture === b.osArchitecture
  );
}

/**
 * Product label for display.
 * Raspberry Pi OS / Raspbian → "Raspberry Pi OS"; debian → "Debian"; etc.
 */
function resolveOsProductName(os: ServerOsMetadata): string | undefined {
  if (isRaspberryPiOs(os)) return "Raspberry Pi OS";
  const id = os.id?.toLowerCase();
  if (id === "debian") return "Debian";
  if (id === "ubuntu") return "Ubuntu";
  if (os.id) return titleCasePhrase(os.id);
  const fromName = os.prettyName?.trim();
  if (fromName) {
    // "Debian GNU/Linux 13 (trixie)" → "Debian"
    const first = fromName.split(/\s+/)[0];
    if (first && first.toLowerCase() !== "gnu") return titleCaseWord(first);
  }
  if (os.family === "linux") return "Linux";
  if (os.family) return titleCaseWord(os.family);
  return undefined;
}

/** Logo key for UI (`debian` | `raspberry-pi-os` | null). */
export function resolveServerOsLogoKey(
  os: ServerOsMetadata | null | undefined,
): "debian" | "raspberry-pi-os" | null {
  if (!os) return null;
  if (isRaspberryPiOs(os)) return "raspberry-pi-os";
  if (os.id?.toLowerCase() === "debian") return "debian";
  return null;
}

/**
 * UI/API display string, e.g. `"Debian 13.5 (Trixie)"` or
 * `"Raspberry Pi OS 12.11 (Bookworm)"`.
 */
export function formatServerOsDisplay(
  os: ServerOsMetadata | null | undefined,
): string | null {
  if (!os) return null;
  const product = resolveOsProductName(os);
  const version = os.version?.trim();
  const codename = os.codename?.trim();
  const codenameLabel = codename ? titleCasePhrase(codename) : undefined;

  if (product && version && codenameLabel) {
    return `${product} ${version} (${codenameLabel})`;
  }
  if (product && version) return `${product} ${version}`;
  if (product && codenameLabel) return `${product} (${codenameLabel})`;
  if (product) return product;
  if (os.prettyName?.trim()) return os.prettyName.trim();
  return null;
}

export function serverOsMetadataEquals(
  a: ServerOsMetadata | null | undefined,
  b: ServerOsMetadata | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.family === b.family &&
    a.id === b.id &&
    a.variant === b.variant &&
    a.version === b.version &&
    a.codename === b.codename &&
    a.prettyName === b.prettyName &&
    a.architecture === b.architecture
  );
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function stringArraysEqual(
  a: string[] | undefined,
  b: string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function optionalIsoTimestamp(value: unknown): string | undefined {
  const trimmed = optionalTrimmedString(value);
  if (!trimmed) return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

function pushNtpHosts(
  out: ServerNtpServerEntry[],
  hosts: string[] | undefined,
  fallback: boolean,
): void {
  if (!hosts) return;
  for (const host of hosts) {
    const trimmed = host.trim();
    if (!trimmed) continue;
    const entry: ServerNtpServerEntry = { host: trimmed };
    if (fallback) entry.fallback = true;
    out.push(entry);
  }
}

function parseNtpObjectList(
  value: unknown,
): ServerNtpServerEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ServerNtpServerEntry[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const host = entry.trim();
      if (host) out.push({ host });
      continue;
    }
    if (!isRecord(entry) || typeof entry.host !== "string") continue;
    const host = entry.host.trim();
    if (!host) continue;
    const row: ServerNtpServerEntry = { host };
    if (entry.fallback === true) row.fallback = true;
    out.push(row);
  }
  return out;
}

/** Parse `server.ntp_servers` jsonb (object array, string array, or `{ servers, fallback }`). */
export function parseNtpServersColumn(
  value: unknown,
): ServerNtpServerEntry[] | undefined {
  if (value === null || value === undefined) return undefined;
  const fromArray = parseNtpObjectList(value);
  if (fromArray !== undefined) return fromArray;
  if (!isRecord(value)) return undefined;
  const out: ServerNtpServerEntry[] = [];
  pushNtpHosts(out, optionalStringArray(value.servers), false);
  pushNtpHosts(out, optionalStringArray(value.fallback), true);
  return out.length > 0 ? out : undefined;
}

export function ntpServersColumnFromTimeSync(
  timeSync: Pick<ServerTimeSync, "ntpServers" | "fallbackNtpServers">,
): ServerNtpServerEntry[] | undefined {
  if (
    timeSync.ntpServers === undefined &&
    timeSync.fallbackNtpServers === undefined
  ) {
    return undefined;
  }
  const out: ServerNtpServerEntry[] = [];
  pushNtpHosts(out, timeSync.ntpServers, false);
  pushNtpHosts(out, timeSync.fallbackNtpServers, true);
  return out;
}

export function splitNtpServersColumn(
  entries: ServerNtpServerEntry[] | undefined,
): {
  ntpServers: string[];
  fallbackNtpServers: string[];
} {
  const ntpServers: string[] = [];
  const fallbackNtpServers: string[] = [];
  if (!entries) return { ntpServers, fallbackNtpServers };
  for (const entry of entries) {
    if (entry.fallback) fallbackNtpServers.push(entry.host);
    else ntpServers.push(entry.host);
  }
  return { ntpServers, fallbackNtpServers };
}

function ntpServerEntriesEqual(
  a: ServerNtpServerEntry[] | undefined,
  b: ServerNtpServerEntry[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.host !== b[i]?.host || a[i]?.fallback !== b[i]?.fallback) {
      return false;
    }
  }
  return true;
}

/** Parse a best-effort time-sync block from daemon hello / stored leftover jsonb. */
export function parseServerTimeSync(
  value: unknown,
): ServerTimeSync | undefined {
  if (!isRecord(value)) return undefined;
  const timeSync: ServerTimeSync = {};
  const timezone = optionalTrimmedString(value.timezone);
  if (timezone) timeSync.timezone = timezone;
  if (typeof value.ntpEnabled === "boolean") {
    timeSync.ntpEnabled = value.ntpEnabled;
  }
  if (typeof value.ntpSynced === "boolean") {
    timeSync.ntpSynced = value.ntpSynced;
  }
  const ntpServers = optionalStringArray(value.ntpServers);
  if (ntpServers !== undefined) timeSync.ntpServers = ntpServers;
  const fallbackNtpServers = optionalStringArray(value.fallbackNtpServers);
  if (fallbackNtpServers !== undefined) {
    timeSync.fallbackNtpServers = fallbackNtpServers;
  }
  const lastSyncedAt = optionalIsoTimestamp(value.lastSyncedAt);
  if (lastSyncedAt) timeSync.lastSyncedAt = lastSyncedAt;
  return Object.keys(timeSync).length > 0 ? timeSync : undefined;
}

function ntpServersColumnPatch(
  incoming: ServerTimeSync,
  current: ServerTimeSyncColumns,
): ServerNtpServerEntry[] | undefined {
  if (ntpServersColumnFromTimeSync(incoming) === undefined) return undefined;
  const currentEntries = parseNtpServersColumn(current.ntpServers) ?? [];
  const currentSplit = splitNtpServersColumn(currentEntries);
  const merged = ntpServersColumnFromTimeSync({
    ntpServers: incoming.ntpServers ?? currentSplit.ntpServers,
    fallbackNtpServers: incoming.fallbackNtpServers ??
      currentSplit.fallbackNtpServers,
  }) ?? [];
  return ntpServerEntriesEqual(merged, currentEntries) ? undefined : merged;
}

/** `undefined` = leave the column; `null` = clear it. */
function ntpLastSyncedAtColumnPatch(
  incoming: ServerTimeSync,
  current: ServerTimeSyncColumns,
  nowIso: string,
): string | null | undefined {
  if (incoming.ntpSynced === false) {
    return current.ntpLastSyncedAt === null ? undefined : null;
  }
  if (incoming.lastSyncedAt) {
    const lastSyncedAt = optionalIsoTimestamp(incoming.lastSyncedAt);
    if (lastSyncedAt && lastSyncedAt !== current.ntpLastSyncedAt) {
      return lastSyncedAt;
    }
    return undefined;
  }
  if (incoming.ntpSynced === true && current.ntpLastSyncedAt === null) {
    return nowIso;
  }
  return undefined;
}

/**
 * Diff incoming daemon time-sync facts against stored columns. Partial
 * timezone-only updates must not clobber NTP fields. `ntp_last_synced_at`
 * is never rewritten to `now()` on every synced heartbeat.
 */
export function timeSyncColumnPatch(
  incoming: ServerTimeSync,
  current: ServerTimeSyncColumns,
  nowIso: string,
): Partial<ServerTimeSyncColumns> | null {
  const patch: Partial<ServerTimeSyncColumns> = {};
  if (incoming.timezone !== undefined) {
    const timezone = optionalTrimmedString(incoming.timezone) ?? null;
    if (timezone !== current.timezone) patch.timezone = timezone;
  }
  if (typeof incoming.ntpEnabled === "boolean") {
    if (incoming.ntpEnabled !== current.isTimeSyncEnabled) {
      patch.isTimeSyncEnabled = incoming.ntpEnabled;
    }
  }
  const ntpServers = ntpServersColumnPatch(incoming, current);
  if (ntpServers !== undefined) patch.ntpServers = ntpServers;
  const lastSyncedAt = ntpLastSyncedAtColumnPatch(incoming, current, nowIso);
  if (lastSyncedAt !== undefined) patch.ntpLastSyncedAt = lastSyncedAt;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Compose the API `timeSync` object from dedicated columns. */
export function timeSyncFromColumns(
  row: ServerTimeSyncColumns,
): ServerTimeSync | undefined {
  const timeSync: ServerTimeSync = {};
  const timezone = optionalTrimmedString(row.timezone);
  if (timezone) timeSync.timezone = timezone;
  if (row.isTimeSyncEnabled !== null) {
    timeSync.ntpEnabled = row.isTimeSyncEnabled;
  }
  const entries = parseNtpServersColumn(row.ntpServers);
  const split = splitNtpServersColumn(entries);
  if (entries !== undefined) {
    timeSync.ntpServers = split.ntpServers;
    if (split.fallbackNtpServers.length > 0) {
      timeSync.fallbackNtpServers = split.fallbackNtpServers;
    }
  }
  if (row.ntpLastSyncedAt) {
    timeSync.ntpSynced = true;
    timeSync.lastSyncedAt = row.ntpLastSyncedAt;
  } else if (row.isTimeSyncEnabled !== null || entries !== undefined) {
    timeSync.ntpSynced = false;
  }
  return Object.keys(timeSync).length > 0 ? timeSync : undefined;
}

/** Compare time-sync facts for equality. */
export function serverTimeSyncEquals(
  a: ServerTimeSync | null | undefined,
  b: ServerTimeSync | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.timezone === b.timezone &&
    a.ntpEnabled === b.ntpEnabled &&
    a.ntpSynced === b.ntpSynced &&
    stringArraysEqual(a.ntpServers, b.ntpServers) &&
    stringArraysEqual(a.fallbackNtpServers, b.fallbackNtpServers)
  );
}

const DOCKER_VERSION_MAX_CHARS = 64;
const DOCKER_VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function parseDockerVersionToken(value: unknown): string | undefined {
  const trimmed = optionalTrimmedString(value);
  if (!trimmed || trimmed.length > DOCKER_VERSION_MAX_CHARS) return undefined;
  let token = trimmed;
  if (token.startsWith("v") || token.startsWith("V")) {
    token = token.slice(1);
  }
  if (!DOCKER_VERSION_TOKEN.test(token)) return undefined;
  return token;
}

/**
 * Runtimes installed on a host, as the daemon reports them.
 *
 * Every area is optional: a host with no PHP reports no `php` key at all, the
 * same discipline `docker` follows.
 */
export type ServerRuntimeMetadata = {
  php?: { series: string[]; extensions?: Record<string, string[]> };
  node?: { series: string[] };
  lsphp?: { series: string[] };
};

/** `8.4` or `24` — the exec boundary, matching the daemon's registry. */
const RUNTIME_SERIES_TOKEN = /^\d{1,3}(\.\d{1,3})?$/;
const RUNTIME_EXTENSION_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_RUNTIME_SERIES = 16;
const MAX_RUNTIME_EXTENSIONS = 128;

function parseRuntimeSeriesList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const series = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => RUNTIME_SERIES_TOKEN.test(entry));
  return [...new Set(series)]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, MAX_RUNTIME_SERIES);
}

/**
 * Parse a best-effort runtimes block. Anything malformed is dropped rather than
 * rejected: a host reporting nonsense should degrade to "unknown inventory",
 * which the prepare gate treats as "will be installed", not to a hard failure
 * that would take the server offline for every deploy.
 */
/** Extension names for one series — canonical, deduped, capped. */
function parseRuntimeExtensionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().toLowerCase())
    .filter((n) => RUNTIME_EXTENSION_TOKEN.test(n));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(
    0,
    MAX_RUNTIME_EXTENSIONS,
  );
}

/** `{ "8.4": ["gd", …] }` — extensions keyed by the series that carries them. */
function parseRuntimeExtensionsBySeries(
  value: unknown,
): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const extensions: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!RUNTIME_SERIES_TOKEN.test(key)) continue;
    const names = parseRuntimeExtensionList(raw);
    if (names.length > 0) extensions[key] = names;
  }
  return extensions;
}

/** The `php` area, which is the one that also carries per-series extensions. */
function parsePhpRuntimeMetadata(value: unknown): ServerRuntimeMetadata["php"] {
  if (!isRecord(value)) return undefined;
  const series = parseRuntimeSeriesList(value.series);
  if (series.length === 0) return undefined;
  const extensions = parseRuntimeExtensionsBySeries(value.extensions);
  if (Object.keys(extensions).length === 0) return { series };
  return { series, extensions };
}

export function parseServerRuntimeMetadata(
  value: unknown,
): ServerRuntimeMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const out: ServerRuntimeMetadata = {};

  const php = parsePhpRuntimeMetadata(value.php);
  if (php) out.php = php;

  for (const area of ["node", "lsphp"] as const) {
    const raw = value[area];
    if (!isRecord(raw)) continue;
    const series = parseRuntimeSeriesList(raw.series);
    if (series.length > 0) out[area] = { series };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function serverRuntimeMetadataEquals(
  a: ServerRuntimeMetadata | undefined,
  b: ServerRuntimeMetadata | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Parse a best-effort docker block from daemon hello / stored metadata. */
export function parseServerDockerMetadata(
  value: unknown,
): ServerDockerMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const docker: ServerDockerMetadata = {};
  const version = parseDockerVersionToken(value.version);
  if (version) docker.version = version;
  const composeVersion = parseDockerVersionToken(value.composeVersion);
  if (composeVersion) docker.composeVersion = composeVersion;
  return Object.keys(docker).length > 0 ? docker : undefined;
}

/** Sensor-slot keys — identity-bearing; a change here bumps `generation`. */
export const HARDWARE_PROFILE_SENSOR_SLOT_KEYS = [
  "cpuTemperature",
  "cpuPower",
  "gpuDevice",
  "gpuFan",
  "disk1Temperature",
  "disk2Temperature",
  "ambient1Temperature",
  "ambient2Temperature",
  "boardTemperature",
  "cpuFan",
  "systemFan1",
  "systemFan2",
] as const satisfies readonly (keyof ServerHardwareProfile)[];

/** NIC binding keys — identity-bearing; a change here also bumps `generation`. */
export const HARDWARE_PROFILE_NIC_KEYS = [
  "nic1",
  "nic2",
] as const satisfies readonly (keyof ServerHardwareProfile)[];

/**
 * Topology-id keys — opaque, daemon-derived device/filesystem ids;
 * identity-bearing like {@link HARDWARE_PROFILE_NIC_KEYS}, a change here also
 * bumps `generation`.
 */
export const HARDWARE_PROFILE_TOPOLOGY_ID_KEYS = [
  "hostingFilesystemId",
] as const satisfies readonly (keyof ServerHardwareProfile)[];

/**
 * The monitored-NIC list key — identity-bearing like
 * {@link HARDWARE_PROFILE_TOPOLOGY_ID_KEYS} (a change bumps `generation`),
 * but list-valued, so it is parsed/merged on its own rather than through the
 * scalar-id loops.
 */
export const HARDWARE_PROFILE_NIC_SLOT_LIST_KEY =
  "nicSlotDeviceIds" as const satisfies keyof ServerHardwareProfile;

/** Update payload for {@link mergeServerHardwareProfile}. */
export type ServerHardwareProfileUpdate =
  & {
    [K in (typeof HARDWARE_PROFILE_SENSOR_SLOT_KEYS)[number]]?:
      | ServerSensorSlotAssignment
      | null;
  }
  & {
    [K in (typeof HARDWARE_PROFILE_NIC_KEYS)[number]]?: string | null;
  }
  & {
    [K in (typeof HARDWARE_PROFILE_TOPOLOGY_ID_KEYS)[number]]?: string | null;
  }
  & {
    /** Full replacement of the monitored-NIC list; `null` (or `[]`) returns the server to auto selection. */
    nicSlotDeviceIds?: string[] | null;
    hostingPath?: string | null;
    drivetempEnabled?: boolean | null;
    /**
     * Operator TDP/Tjmax overrides. Not identity-bearing — follow the same
     * undefined-leaves / null-clears convention as `hostingPath` /
     * `drivetempEnabled` and never bump `generation`. `cpuModel` is
     * intentionally absent here — it is a detected fact written only by the
     * host-facts projection path, never by this operator update.
     */
    cpuTdpWattsOverride?: number | null;
    cpuTjMaxCelsiusOverride?: number | null;
  };

function parseSensorSlot(value: unknown): ServerSensorSlot | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const chip = optionalTrimmedString(value.chip);
  const label = optionalTrimmedString(value.label);
  if (!chip || !label) return undefined;
  return { chip, label };
}

function parseNicBinding(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalTrimmedString(value);
}

/** Same parse discipline as {@link parseNicBinding} — an opaque id string, `null`, or absent. */
function parseTopologyIdBinding(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalTrimmedString(value);
}

function applyHardwareProfileSensorSlots(
  value: Record<string, unknown>,
  profile: ServerHardwareProfile,
): void {
  for (const key of HARDWARE_PROFILE_SENSOR_SLOT_KEYS) {
    if (!(key in value)) continue;
    const slot = parseSensorSlot(value[key]);
    if (slot !== undefined) profile[key] = slot;
  }
}

function applyHardwareProfileNicBindings(
  value: Record<string, unknown>,
  profile: ServerHardwareProfile,
): void {
  for (const key of HARDWARE_PROFILE_NIC_KEYS) {
    if (!(key in value)) continue;
    const nic = parseNicBinding(value[key]);
    if (nic !== undefined) profile[key] = nic;
  }
}

function applyHardwareProfileTopologyIdBindings(
  value: Record<string, unknown>,
  profile: ServerHardwareProfile,
): void {
  for (const key of HARDWARE_PROFILE_TOPOLOGY_ID_KEYS) {
    if (!(key in value)) continue;
    const id = parseTopologyIdBinding(value[key]);
    if (id !== undefined) profile[key] = id;
  }
}

/** Trimmed, non-blank, deduplicated (first-seen order) id list; `undefined` when `value` is not an array. */
function parseTopologyIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const entry of value) {
    const id = optionalTrimmedString(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * `nicSlotDeviceIds` from stored metadata. Only the current list key is
 * accepted; `nicSlot1DeviceId` / `nicSlot2DeviceId` are ignored.
 */
function applyHardwareProfileNicSlotList(
  value: Record<string, unknown>,
  profile: ServerHardwareProfile,
): void {
  const list = parseTopologyIdList(value[HARDWARE_PROFILE_NIC_SLOT_LIST_KEY]);
  if (list !== undefined) {
    profile.nicSlotDeviceIds = list;
  }
}

/** Shared by both nullable-override fields: `null` clears, a parse failure leaves it unset. */
function applyParsedNullableOverride<V>(
  present: boolean,
  raw: unknown,
  parse: (value: unknown) => V | undefined,
  apply: (value: V | null) => void,
): void {
  if (!present) return;
  if (raw === null) {
    apply(null);
    return;
  }
  const parsed = parse(raw);
  if (parsed !== undefined) apply(parsed);
}

/** Parse a best-effort hardware-profile block from stored metadata. */
export function parseServerHardwareProfile(
  value: unknown,
): ServerHardwareProfile | undefined {
  if (!isRecord(value)) return undefined;
  const profile: ServerHardwareProfile = {};
  applyHardwareProfileSensorSlots(value, profile);
  applyHardwareProfileNicBindings(value, profile);
  applyHardwareProfileTopologyIdBindings(value, profile);
  applyHardwareProfileNicSlotList(value, profile);

  const hostingPath = optionalTrimmedString(value.hostingPath);
  if (hostingPath) profile.hostingPath = hostingPath;
  if (typeof value.drivetempEnabled === "boolean") {
    profile.drivetempEnabled = value.drivetempEnabled;
  }
  if (
    typeof value.generation === "number" &&
    Number.isInteger(value.generation) &&
    value.generation >= 0
  ) {
    profile.generation = value.generation;
  }
  const generationAppliedAt = optionalIsoTimestamp(value.generationAppliedAt);
  if (generationAppliedAt) profile.generationAppliedAt = generationAppliedAt;
  const cpuModel = optionalTrimmedString(value.cpuModel);
  if (cpuModel && cpuModel.length <= MAX_CPU_MODEL_CHARS) {
    profile.cpuModel = cpuModel;
  }

  applyParsedNullableOverride(
    "cpuTdpWattsOverride" in value,
    value.cpuTdpWattsOverride,
    optionalCpuTdpWatts,
    (tdpWatts) => {
      profile.cpuTdpWattsOverride = tdpWatts;
    },
  );
  applyParsedNullableOverride(
    "cpuTjMaxCelsiusOverride" in value,
    value.cpuTjMaxCelsiusOverride,
    optionalCpuTjMaxCelsius,
    (tjMaxCelsius) => {
      profile.cpuTjMaxCelsiusOverride = tjMaxCelsius;
    },
  );

  return Object.keys(profile).length > 0 ? profile : undefined;
}

/** `undefined` vs `null` are distinct sentinels — unset vs explicitly unassigned. */
function sensorSlotIdentityEquals(
  a: ServerSensorSlot | undefined,
  b: ServerSensorSlot | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  return a.chip === b.chip && a.label === b.label;
}

function nicBindingEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a === b;
}

/** Same identity comparison as {@link nicBindingEquals} — used for topology-id fields. */
function topologyIdBindingEquals(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return a === b;
}

/**
 * Merge a partial hardware-profile update onto the stored profile.
 *
 * Per sensor-slot / NIC / topology-id field: an assignment (or interface
 * name / opaque id) pins it, an explicit `null` marks it unassigned,
 * `undefined` leaves it untouched. `hostingPath` / `drivetempEnabled` /
 * `cpuTdpWattsOverride` / `cpuTjMaxCelsiusOverride` follow the same
 * undefined-leaves, null-clears convention but never bump `generation` —
 * they carry no sensor identity. `generation` bumps (and
 * `generationAppliedAt` stamps `nowIso`) only when a sensor-slot, NIC, or
 * topology-id identity actually changed; an otherwise no-op save is
 * idempotent.
 */
function applySensorSlotUpdates(
  existing: ServerHardwareProfile | undefined,
  update: ServerHardwareProfileUpdate,
  next: ServerHardwareProfile,
): boolean {
  let changed = false;
  for (const key of HARDWARE_PROFILE_SENSOR_SLOT_KEYS) {
    const incoming = update[key];
    if (incoming === undefined) continue;
    const value: ServerSensorSlot = incoming === null
      ? null
      : { chip: incoming.chip.trim(), label: incoming.label.trim() };
    if (!sensorSlotIdentityEquals(existing?.[key], value)) changed = true;
    next[key] = value;
  }
  return changed;
}

function applyNicBindingUpdates(
  existing: ServerHardwareProfile | undefined,
  update: ServerHardwareProfileUpdate,
  next: ServerHardwareProfile,
): boolean {
  let changed = false;
  for (const key of HARDWARE_PROFILE_NIC_KEYS) {
    const incoming = update[key];
    if (incoming === undefined) continue;
    const value = incoming === null ? null : incoming.trim();
    if (!nicBindingEquals(existing?.[key], value)) changed = true;
    next[key] = value;
  }
  return changed;
}

function applyTopologyIdBindingUpdates(
  existing: ServerHardwareProfile | undefined,
  update: ServerHardwareProfileUpdate,
  next: ServerHardwareProfile,
): boolean {
  let changed = false;
  for (const key of HARDWARE_PROFILE_TOPOLOGY_ID_KEYS) {
    const incoming = update[key];
    if (incoming === undefined) continue;
    const value = incoming === null ? null : incoming.trim();
    if (!topologyIdBindingEquals(existing?.[key], value)) changed = true;
    next[key] = value;
  }
  return changed;
}

/**
 * Full replacement of the monitored-NIC list. `null`/`[]` returns the server
 * to auto selection (stored as an absent key, the same "never configured"
 * shape). Identity-bearing: any change in membership *or order* bumps
 * `generation`, since slot position is what the stored series are keyed by.
 */
function applyNicSlotListUpdate(
  existing: ServerHardwareProfile | undefined,
  update: ServerHardwareProfileUpdate,
  next: ServerHardwareProfile,
): boolean {
  const incoming = update.nicSlotDeviceIds;
  if (incoming === undefined) return false;
  const value = parseTopologyIdList(incoming) ?? [];
  const previous = existing?.nicSlotDeviceIds ?? [];
  const changed = value.length !== previous.length ||
    value.some((id, index) => id !== previous[index]);
  if (value.length === 0) delete next.nicSlotDeviceIds;
  else next.nicSlotDeviceIds = value;
  return changed;
}

function applyHostingPathUpdate(
  update: ServerHardwareProfileUpdate,
  next: ServerHardwareProfile,
): void {
  if (update.hostingPath === undefined) return;
  if (update.hostingPath === null) {
    delete next.hostingPath;
    return;
  }
  const trimmed = update.hostingPath.trim();
  if (trimmed.length === 0) delete next.hostingPath;
  else next.hostingPath = trimmed;
}

/** `undefined` leaves a field untouched, `null` clears it, else it replaces it. */
function applyNullableUpdate<V>(
  incoming: V | null | undefined,
  apply: (value: V) => void,
  clear: () => void,
): void {
  if (incoming === undefined) return;
  if (incoming === null) {
    clear();
    return;
  }
  apply(incoming);
}

function applyGenerationBump(
  existing: ServerHardwareProfile | undefined,
  next: ServerHardwareProfile,
  identityChanged: boolean,
  nowIso: string,
): void {
  if (identityChanged) {
    next.generation = (existing?.generation ?? 0) + 1;
    next.generationAppliedAt = nowIso;
    return;
  }
  if (existing?.generation === undefined) return;
  next.generation = existing.generation;
  if (existing.generationAppliedAt !== undefined) {
    next.generationAppliedAt = existing.generationAppliedAt;
  }
}

export function mergeServerHardwareProfile(
  existing: ServerHardwareProfile | undefined,
  update: ServerHardwareProfileUpdate,
  nowIso: string,
): { profile: ServerHardwareProfile | undefined; identityChanged: boolean } {
  const next: ServerHardwareProfile = { ...existing };

  const sensorSlotsChanged = applySensorSlotUpdates(existing, update, next);
  const nicBindingsChanged = applyNicBindingUpdates(existing, update, next);
  const topologyIdBindingsChanged = applyTopologyIdBindingUpdates(
    existing,
    update,
    next,
  );
  const nicSlotListChanged = applyNicSlotListUpdate(existing, update, next);
  const identityChanged = sensorSlotsChanged || nicBindingsChanged ||
    topologyIdBindingsChanged || nicSlotListChanged;

  applyHostingPathUpdate(update, next);
  applyNullableUpdate(
    update.drivetempEnabled,
    (v) => {
      next.drivetempEnabled = v;
    },
    () => {
      delete next.drivetempEnabled;
    },
  );
  applyNullableUpdate(
    update.cpuTdpWattsOverride,
    (v) => {
      next.cpuTdpWattsOverride = v;
    },
    () => {
      delete next.cpuTdpWattsOverride;
    },
  );
  applyNullableUpdate(
    update.cpuTjMaxCelsiusOverride,
    (v) => {
      next.cpuTjMaxCelsiusOverride = v;
    },
    () => {
      delete next.cpuTjMaxCelsiusOverride;
    },
  );

  applyGenerationBump(existing, next, identityChanged, nowIso);

  const profile = Object.keys(next).length > 0 ? next : undefined;
  return { profile, identityChanged };
}

export type EffectiveCpuThermalLimits = {
  tdpWatts: number | null;
  tjMaxCelsius: number | null;
  source: "override" | "catalog-exact" | "catalog-family" | "none";
};

/**
 * Resolve effective CPU thermal limits for headroom display: a per-server
 * override wins outright per field (a server may override just one of the
 * two), otherwise both fall back together to the catalog entry resolved
 * from the detected {@link ServerHardwareProfile.cpuModel}, otherwise
 * `'none'`. Mixed override+catalog reports `'override'` — the caller cares
 * whether *any* value came from an operator's deliberate choice.
 */
export function resolveEffectiveCpuThermalLimits(
  profile: ServerHardwareProfile | undefined,
): EffectiveCpuThermalLimits {
  const tdpOverride = profile?.cpuTdpWattsOverride ?? null;
  const tjMaxOverride = profile?.cpuTjMaxCelsiusOverride ?? null;
  if (tdpOverride !== null || tjMaxOverride !== null) {
    const catalog = resolveCpuCatalogEntry(profile?.cpuModel);
    return {
      tdpWatts: tdpOverride ?? catalog?.tdpWatts ?? null,
      tjMaxCelsius: tjMaxOverride ?? catalog?.tjMaxCelsius ?? null,
      source: "override",
    };
  }

  const catalog = resolveCpuCatalogEntry(profile?.cpuModel);
  if (catalog) {
    return {
      tdpWatts: catalog.tdpWatts,
      tjMaxCelsius: catalog.tjMaxCelsius,
      source: isExactCpuCatalogMatch(profile?.cpuModel)
        ? "catalog-exact"
        : "catalog-family",
    };
  }

  return { tdpWatts: null, tjMaxCelsius: null, source: "none" };
}

/**
 * Resolve the effective v4 metrics capability plan for a server:
 * `machineClass`-scoped platform default → org-wide
 * `organization.options.metricsCapabilityPlan` → per-server
 * `server.options.metricsCapabilityPlan`, field by field. Unlike
 * {@link resolveEffectiveCpuThermalLimits}, plan fields aren't independently
 * sourced-labeled — a single resolved object is sufficient here.
 *
 * `machineClass` is required so a virtual server can never resolve the
 * physical `physicalHardwareSignalSlots` default (see
 * `../../daemon/metrics/capability-plan.ts`'s
 * `platformDefaultMetricsCapabilityPlan`) — ingest (`api-routes.ts`)
 * classifies the reporting server from its persisted topology snapshot
 * (`classifyServerMachineForMetrics`) and supplies the result here.
 */
export function resolveEffectiveMetricsCapabilityPlan(
  machineClass: ServerMachineClass,
  orgOptions: OrganizationOptions | undefined,
  serverOptions: ServerOptions | undefined,
  deployment: MetricsDeploymentKind,
): MetricsCapabilityPlanV4 {
  return resolveMetricsCapabilityPlan(
    machineClass,
    orgOptions?.metricsCapabilityPlan,
    serverOptions?.metricsCapabilityPlan,
    deployment,
  );
}

export function serverDockerMetadataEquals(
  a: ServerDockerMetadata | null | undefined,
  b: ServerDockerMetadata | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.version === b.version && a.composeVersion === b.composeVersion;
}

/**
 * `server.options` keys that must never leave the control plane.
 *
 * `options` is returned verbatim by `GET /servers`, `GET /servers/:id` and the
 * developer server routes, and the approved cached read models copy the whole
 * jsonb into Redis — so a secret written there is published to every reader and
 * cached outside Postgres. `managedMonitor` was such a key (a sealed ProxySQL
 * monitor password); it now lives on the `monitor` table
 * (`src/client/managed/monitor-credential.ts`). This list is the belt to that
 * change's braces: rows written before the move, or by a control plane that
 * skipped it, still must not be served or cached.
 *
 * Nothing is ever added here as a way to keep storing a secret on `options` —
 * a new secret belongs in its own table.
 */
export const REDACTED_SERVER_OPTION_KEYS: readonly string[] = [
  "managedMonitor",
];

/**
 * `server.options` with every {@link REDACTED_SERVER_OPTION_KEYS} entry removed.
 *
 * Apply this at the boundary of anything that serializes or caches the raw
 * jsonb — the read models cache what this returns, never the row as selected.
 * Returns the input untouched when there is nothing to strip, so the common
 * path allocates nothing.
 */
export function redactServerOptions<T>(value: T): T {
  if (!isRecord(value)) return value;
  const present = REDACTED_SERVER_OPTION_KEYS.filter((key) => key in value);
  if (present.length === 0) return value;
  const copy = { ...value };
  for (const key of present) delete copy[key];
  return copy as T;
}

/** Parse operator-controlled `server.options` jsonb. */
export function parseServerOptions(value: unknown): ServerOptions | null {
  if (!isRecord(value)) return null;
  const options: ServerOptions = {};
  const timezone = optionalTrimmedString(value.timezone);
  if (timezone) options.timezone = timezone;
  const cellLocationHint = optionalTrimmedString(value.cellLocationHint);
  if (cellLocationHint) options.cellLocationHint = cellLocationHint;
  if (
    typeof value.cellGeneration === "number" &&
    Number.isInteger(value.cellGeneration)
  ) {
    options.cellGeneration = value.cellGeneration;
  }
  if (isRecord(value.hosting) && typeof value.hosting.enabled === "boolean") {
    options.hosting = { enabled: value.hosting.enabled };
  }
  const sshPort = parseSshPort(value.sshPort);
  if (sshPort !== undefined) options.sshPort = sshPort;
  const ntp = parseNtpDefaults(value.ntp);
  if (ntp) options.ntp = ntp;
  if ("metricsCapabilityPlan" in value) {
    const metricsCapabilityPlan = parseServerMetricsCapabilityPlanOverride(
      value.metricsCapabilityPlan,
    );
    if (Object.keys(metricsCapabilityPlan).length > 0) {
      options.metricsCapabilityPlan = metricsCapabilityPlan;
    }
  }
  return Object.keys(options).length > 0 ? options : {};
}

export type EffectiveServerTimezone = {
  timezone: string | null;
  source: "server" | "organization" | "datacenter" | null;
};

/**
 * Resolve configured server timezone (enforced defaults and explicit overrides).
 *
 * Precedence: datacenter enforce, org enforce, `server.options.timezone`.
 * Non-enforcing org/datacenter defaults and daemon-reported zones are applied
 * in API routes via {@link resolveServerResponseTimezone}.
 */
export function resolveEffectiveServerTimezone(
  serverOptions: ServerOptions | null | undefined,
  orgOptions: OrganizationOptions | null | undefined,
  datacenterOptions?: DatacenterOptions | null,
): EffectiveServerTimezone {
  const dcDefault = datacenterOptions?.defaultServerTimezone?.trim() || null;
  const orgDefault = orgOptions?.defaultServerTimezone?.trim() || null;

  if (datacenterOptions?.enforceServerTimezone && dcDefault) {
    return { timezone: dcDefault, source: "datacenter" };
  }
  if (datacenterOptions?.enforceServerTimezone) {
    return { timezone: null, source: null };
  }
  if (orgOptions?.enforceServerTimezone) {
    return {
      timezone: orgDefault,
      source: orgDefault ? "organization" : null,
    };
  }
  const serverTz = serverOptions?.timezone?.trim() || null;
  if (serverTz) {
    return { timezone: serverTz, source: "server" };
  }
  return { timezone: null, source: null };
}

/** Apply daemon-reported timezone when no configured override was resolved. */
export function resolveServerResponseTimezone(
  effective: EffectiveServerTimezone,
  daemonReportedTimezone: string | null | undefined,
): EffectiveServerTimezone {
  if (effective.timezone !== null) {
    return effective;
  }
  const timezone = daemonReportedTimezone?.trim() || null;
  return { timezone, source: null };
}
