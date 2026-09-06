/**
 * Builds UI-facing entity inventories from a daemon-reported `TopologySnapshot`
 * (`getLatestTopologyGeneration` / `server-topology-records.ts`) plus its
 * derived `SlotMapping` (`topology-slot-mapping.ts`) — the label/role metadata
 * the v4 metrics routes attach to `network`/`filesystem`/`block`/`gpu`/
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
export type NetworkEntityRoleV4 = 'nic' | 'fabric' | 'other'

export type NetworkInventoryEntryV4 = {
  deviceId: string
  name: string
  kind: NetworkDeviceKind
  role: NetworkEntityRoleV4
  /** 1-based NIC slot when `role === 'nic'` — slots 1/2 embed in `host.io` on Cloudflare, 3+ page as `network` rows. */
  slot?: number
  speedMbps?: number
  mtu?: number
  /** Mirrors the snapshot's `defaultRoute` flag — the gateway uplink the auto slot selection would pick. */
  defaultRoute?: boolean
}

export type FilesystemInventoryEntryV4 = {
  filesystemId: string
  mountpoint: string
  roles: FilesystemRole[]
  totalBytes: number | null
  /** Whether this is the current `SlotMapping.rootFilesystemId`. */
  isRoot: boolean
}

export type BlockDeviceInventoryEntryV4 = {
  deviceId: string
  kernelName: string
  model?: string
  deviceType: BlockDeviceType
  isServiceDevice: boolean
}

export type GpuInventoryEntryV4 = {
  gpuId: string
  kind: GpuKind
  vendor: string
  chip: string
}

export type HardwareSignalInventoryEntryV4 = {
  signalId: string
  kind: string
  unit: string
  label: string
  thresholds?: PhysicalSignalThresholds
}

export type TopologyInventoryV4 = {
  networks: NetworkInventoryEntryV4[]
  filesystems: FilesystemInventoryEntryV4[]
  blockDevices: BlockDeviceInventoryEntryV4[]
  gpus: GpuInventoryEntryV4[]
  hardwareSignals: HardwareSignalInventoryEntryV4[]
}

function networkRole(
  deviceId: string,
  slotMapping: SlotMapping
): { role: NetworkEntityRoleV4; slot?: number } {
  const slotIndex = slotMapping.normalNicSlots.indexOf(deviceId)
  if (slotIndex !== -1) return { role: 'nic', slot: slotIndex + 1 }
  if (slotMapping.fabricDeviceIds.includes(deviceId)) return { role: 'fabric' }
  return { role: 'other' }
}

/** Build every family's inventory from one topology snapshot + its slot mapping. */
export function buildTopologyInventoryV4(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): TopologyInventoryV4 {
  const networks: NetworkInventoryEntryV4[] = snapshot.networks.map((device) => ({
    deviceId: device.deviceId,
    name: device.name,
    kind: device.kind,
    ...networkRole(device.deviceId, slotMapping),
    ...(device.speedMbps !== undefined ? { speedMbps: device.speedMbps } : {}),
    ...(device.mtu !== undefined ? { mtu: device.mtu } : {}),
    ...(device.defaultRoute === true ? { defaultRoute: true } : {}),
  }))

  const filesystems: FilesystemInventoryEntryV4[] = snapshot.filesystems.map((fs) => ({
    filesystemId: fs.filesystemId,
    mountpoint: fs.mountpoint,
    roles: fs.roles,
    totalBytes: fs.totalBytes,
    isRoot: fs.filesystemId === slotMapping.rootFilesystemId,
  }))

  const blockDevices: BlockDeviceInventoryEntryV4[] = snapshot.blockDevices.map((device) => ({
    deviceId: device.deviceId,
    kernelName: device.kernelName,
    ...(device.model !== undefined ? { model: device.model } : {}),
    deviceType: device.deviceType,
    isServiceDevice: device.isServiceDevice,
  }))

  const gpus: GpuInventoryEntryV4[] = snapshot.gpus.map((gpu) => ({
    gpuId: gpu.gpuId,
    kind: gpu.kind,
    vendor: gpu.vendor,
    chip: gpu.chip,
  }))

  const hardwareSignals: HardwareSignalInventoryEntryV4[] = snapshot.hardwareSignals.map(
    (signal) => ({
      signalId: signal.signalId,
      kind: signal.kind,
      unit: signal.unit,
      label: signal.label,
      ...(signal.thresholds !== undefined ? { thresholds: signal.thresholds } : {}),
    })
  )

  return { networks, filesystems, blockDevices, gpus, hardwareSignals }
}

/**
 * The root-role filesystem's `totalBytes` per the current `SlotMapping`, or
 * `null` when no filesystem is marked root or its capacity is unknown —
 * feeds `derived-metrics-v4.ts`'s `HostCapacitiesV4.rootFilesystemTotalBytes`.
 */
export function rootFilesystemTotalBytesV4(
  snapshot: TopologySnapshot,
  slotMapping: SlotMapping
): number | null {
  if (!slotMapping.rootFilesystemId) return null
  const filesystem = snapshot.filesystems.find(
    (fs) => fs.filesystemId === slotMapping.rootFilesystemId
  )
  return filesystem?.totalBytes ?? null
}
