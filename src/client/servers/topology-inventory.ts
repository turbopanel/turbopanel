/**
 * Builds UI-facing entity inventories from a daemon-reported `TopologySnapshot`
 * (`getLatestTopologyGeneration` / `server-topology-records.ts`) plus its
 * derived `SlotMapping` (`topology-slot-mapping.ts`) — the label/role metadata
 * the v5 metrics routes attach to `network`/`filesystem`/`block`/`gpu`/
 * `hardwareSignal` entity series so a chart legend never has to show a bare
 * device id with no name or role context.
 *
 * `managed.ingress` / `managed.database_proxy` have no topology concept at
 * all — an ingress/database-proxy source is presence-only, discovered by
 * `queryEntityIdsSeen` against the actual queried range, never invented here.
 */
import type {
  BlockDeviceType,
  FilesystemRole,
  GpuKind,
  NetworkDeviceKind,
  PhysicalSignalThresholds,
  SlotMapping,
  TopologySnapshot,
} from './topology-types.ts'

/**
 * A device's role per the current `SlotMapping`: `nic` is a monitored
 * normal-NIC slot (its 1-based `slot` rides alongside), `fabric` a TurboFabric
 * mesh device, `other` everything the daemon enumerates but never samples
 * (members, VLAN children, tunnels, container bridges, loopback — or an
 * uplink the operator hasn't added to the monitored list).
 */
export type NetworkEntityRole = 'nic' | 'fabric' | 'other'

export type NetworkInventoryEntry = {
  deviceId: string
  name: string
  kind: NetworkDeviceKind
  role: NetworkEntityRole
  /** 1-based NIC slot when `role === 'nic'` — slots 1/2 embed in `host.io` on Cloudflare, 3+ page as `network` rows. */
  slot?: number
  speedMbps?: number
  mtu?: number
  /** Mirrors the snapshot's `defaultRoute` flag — the gateway uplink the auto slot selection would pick. */
  defaultRoute?: boolean
}

export type FilesystemInventoryEntry = {
  filesystemId: string
  mountpoint: string
  roles: FilesystemRole[]
  totalBytes: number | null
  /** Whether this is the current `SlotMapping.rootFilesystemId`. */
  isRoot: boolean
}

export type BlockDeviceInventoryEntry = {
  deviceId: string
  kernelName: string
  model?: string
  deviceType: BlockDeviceType
  isServiceDevice: boolean
}

export type GpuInventoryEntry = {
  gpuId: string
  kind: GpuKind
  vendor: string
  chip: string
}

export type HardwareSignalInventoryEntry = {
  signalId: string
  kind: string
  unit: string
  /**
   * Which part of the machine this sensor belongs to (`cpu` / `disk` /
   * `board`). The daemon has always resolved this; v4 dropped it here, so the
   * UI rendered a bare kernel label with no attribution — two NVMe drives
   * both showed an indistinguishable "Composite".
   */
  component: string
  /**
   * The hwmon chip, resolved to the backing block device for storage sensors
   * (`nvme0n1`, `sda`) — parsed out of `signalId`, which the daemon forms as
   * `signal:<chip>:<label>`. Carried explicitly so the UI never has to
   * re-parse the id.
   */
  chip: string
  label: string
  thresholds?: PhysicalSignalThresholds
}

/**
 * Prefixes of the entity-joined signal ids (`signal:gpu:<gpuId>:<kind>`,
 * `signal:block:<deviceId>:temperature`). These carry no hwmon chip at all —
 * a GPU's readings come from NVML/DCGM/sysfs and a drive's whole-drive
 * temperature is derived from its probes — and the segment after the prefix
 * is an opaque `GpuId`/`TopologyDeviceId` that may itself contain a `:`, so
 * they must never be split apart the way an `signal:<chip>:<label>` id is.
 */
const ENTITY_JOINED_SIGNAL_PREFIXES = ['signal:gpu:', 'signal:block:'] as const

/** The `<chip>` segment of a `signal:<chip>:<label>` id; empty when the id isn't that shape (an entity-joined id included — see {@link ENTITY_JOINED_SIGNAL_PREFIXES}). */
export function hardwareSignalChip(signalId: string): string {
  if (ENTITY_JOINED_SIGNAL_PREFIXES.some((prefix) => signalId.startsWith(prefix))) return ''
  const parts = signalId.split(':')
  return parts.length >= 3 && parts[0] === 'signal' ? parts[1]! : ''
}

export type TopologyInventory = {
  networks: NetworkInventoryEntry[]
  filesystems: FilesystemInventoryEntry[]
  blockDevices: BlockDeviceInventoryEntry[]
  gpus: GpuInventoryEntry[]
  hardwareSignals: HardwareSignalInventoryEntry[]
}

function networkRole(
  deviceId: string,
  slotMapping: SlotMapping
): { role: NetworkEntityRole; slot?: number } {
  const slotIndex = slotMapping.normalNicSlots.indexOf(deviceId)
  if (slotIndex !== -1) return { role: 'nic', slot: slotIndex + 1 }
  if (slotMapping.fabricDeviceIds.includes(deviceId)) return { role: 'fabric' }
  return { role: 'other' }
}

/** Build every family's inventory from one topology snapshot + its slot mapping. */
export function buildTopologyInventory(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): TopologyInventory {
  const networks: NetworkInventoryEntry[] = snapshot.networks.map((device) => ({
    deviceId: device.deviceId,
    name: device.name,
    kind: device.kind,
    ...networkRole(device.deviceId, slotMapping),
    ...(device.speedMbps !== undefined ? { speedMbps: device.speedMbps } : {}),
    ...(device.mtu !== undefined ? { mtu: device.mtu } : {}),
    ...(device.defaultRoute === true ? { defaultRoute: true } : {}),
  }))

  const filesystems: FilesystemInventoryEntry[] = snapshot.filesystems.map((fs) => ({
    filesystemId: fs.filesystemId,
    mountpoint: fs.mountpoint,
    roles: fs.roles,
    totalBytes: fs.totalBytes,
    isRoot: fs.filesystemId === slotMapping.rootFilesystemId,
  }))

  const blockDevices: BlockDeviceInventoryEntry[] = snapshot.blockDevices.map((device) => ({
    deviceId: device.deviceId,
    kernelName: device.kernelName,
    ...(device.model !== undefined ? { model: device.model } : {}),
    deviceType: device.deviceType,
    isServiceDevice: device.isServiceDevice,
  }))

  const gpus: GpuInventoryEntry[] = snapshot.gpus.map((gpu) => ({
    gpuId: gpu.gpuId,
    kind: gpu.kind,
    vendor: gpu.vendor,
    chip: gpu.chip,
  }))

  const hardwareSignals: HardwareSignalInventoryEntry[] = snapshot.hardwareSignals.map(
    (signal) => ({
      signalId: signal.signalId,
      kind: signal.kind,
      unit: signal.unit,
      component: signal.component,
      chip: hardwareSignalChip(signal.signalId),
      label: signal.label,
      ...(signal.thresholds !== undefined ? { thresholds: signal.thresholds } : {}),
    })
  )

  return { networks, filesystems, blockDevices, gpus, hardwareSignals }
}

/**
 * The root-role filesystem's `totalBytes` per the current `SlotMapping`, or
 * `null` when no filesystem is marked root or its capacity is unknown —
 * feeds `derived-metrics.ts`'s `HostCapacities.rootFilesystemTotalBytes`.
 */
export function rootFilesystemTotalBytes(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): number | null {
  if (!slotMapping.rootFilesystemId) return null
  const filesystem = snapshot.filesystems.find(
    (fs) => fs.filesystemId === slotMapping.rootFilesystemId
  )
  return filesystem?.totalBytes ?? null
}
