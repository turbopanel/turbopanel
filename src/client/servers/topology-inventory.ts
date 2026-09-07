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
export type NetworkEntityRoleV5 = 'nic' | 'fabric' | 'other'

export type NetworkInventoryEntryV5 = {
  deviceId: string
  name: string
  kind: NetworkDeviceKind
  role: NetworkEntityRoleV5
  /** 1-based NIC slot when `role === 'nic'` — slots 1/2 embed in `host.io` on Cloudflare, 3+ page as `network` rows. */
  slot?: number
  speedMbps?: number
  mtu?: number
  /** Mirrors the snapshot's `defaultRoute` flag — the gateway uplink the auto slot selection would pick. */
  defaultRoute?: boolean
}

export type FilesystemInventoryEntryV5 = {
  filesystemId: string
  mountpoint: string
  roles: FilesystemRole[]
  totalBytes: number | null
  /** Whether this is the current `SlotMapping.rootFilesystemId`. */
  isRoot: boolean
}

export type BlockDeviceInventoryEntryV5 = {
  deviceId: string
  kernelName: string
  model?: string
  deviceType: BlockDeviceType
  isServiceDevice: boolean
}

export type GpuInventoryEntryV5 = {
  gpuId: string
  kind: GpuKind
  vendor: string
  chip: string
}

export type HardwareSignalInventoryEntryV5 = {
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

/** The `<chip>` segment of a `signal:<chip>:<label>` id; empty when the id isn't that shape. */
export function hardwareSignalChipV5(signalId: string): string {
  const parts = signalId.split(':')
  return parts.length >= 3 && parts[0] === 'signal' ? parts[1]! : ''
}

export type TopologyInventoryV5 = {
  networks: NetworkInventoryEntryV5[]
  filesystems: FilesystemInventoryEntryV5[]
  blockDevices: BlockDeviceInventoryEntryV5[]
  gpus: GpuInventoryEntryV5[]
  hardwareSignals: HardwareSignalInventoryEntryV5[]
}

function networkRole(
  deviceId: string,
  slotMapping: SlotMapping
): { role: NetworkEntityRoleV5; slot?: number } {
  const slotIndex = slotMapping.normalNicSlots.indexOf(deviceId)
  if (slotIndex !== -1) return { role: 'nic', slot: slotIndex + 1 }
  if (slotMapping.fabricDeviceIds.includes(deviceId)) return { role: 'fabric' }
  return { role: 'other' }
}

/** Build every family's inventory from one topology snapshot + its slot mapping. */
export function buildTopologyInventoryV5(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): TopologyInventoryV5 {
  const networks: NetworkInventoryEntryV5[] = snapshot.networks.map((device) => ({
    deviceId: device.deviceId,
    name: device.name,
    kind: device.kind,
    ...networkRole(device.deviceId, slotMapping),
    ...(device.speedMbps !== undefined ? { speedMbps: device.speedMbps } : {}),
    ...(device.mtu !== undefined ? { mtu: device.mtu } : {}),
    ...(device.defaultRoute === true ? { defaultRoute: true } : {}),
  }))

  const filesystems: FilesystemInventoryEntryV5[] = snapshot.filesystems.map((fs) => ({
    filesystemId: fs.filesystemId,
    mountpoint: fs.mountpoint,
    roles: fs.roles,
    totalBytes: fs.totalBytes,
    isRoot: fs.filesystemId === slotMapping.rootFilesystemId,
  }))

  const blockDevices: BlockDeviceInventoryEntryV5[] = snapshot.blockDevices.map((device) => ({
    deviceId: device.deviceId,
    kernelName: device.kernelName,
    ...(device.model !== undefined ? { model: device.model } : {}),
    deviceType: device.deviceType,
    isServiceDevice: device.isServiceDevice,
  }))

  const gpus: GpuInventoryEntryV5[] = snapshot.gpus.map((gpu) => ({
    gpuId: gpu.gpuId,
    kind: gpu.kind,
    vendor: gpu.vendor,
    chip: gpu.chip,
  }))

  const hardwareSignals: HardwareSignalInventoryEntryV5[] = snapshot.hardwareSignals.map(
    (signal) => ({
      signalId: signal.signalId,
      kind: signal.kind,
      unit: signal.unit,
      component: signal.component,
      chip: hardwareSignalChipV5(signal.signalId),
      label: signal.label,
      ...(signal.thresholds !== undefined ? { thresholds: signal.thresholds } : {}),
    })
  )

  return { networks, filesystems, blockDevices, gpus, hardwareSignals }
}

/**
 * The root-role filesystem's `totalBytes` per the current `SlotMapping`, or
 * `null` when no filesystem is marked root or its capacity is unknown —
 * feeds `derived-metrics-v5.ts`'s `HostCapacitiesV5.rootFilesystemTotalBytes`.
 */
export function rootFilesystemTotalBytesV5(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): number | null {
  if (!slotMapping.rootFilesystemId) return null
  const filesystem = snapshot.filesystems.find(
    (fs) => fs.filesystemId === slotMapping.rootFilesystemId
  )
  return filesystem?.totalBytes ?? null
}
