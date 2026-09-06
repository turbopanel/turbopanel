/**
 * Control-plane mirror of the daemon's topology discovery types
 * (`turbopaneld/src/metrics/topology/types.ts`) — kept in sync by hand, the
 * same way `contract.ts` mirrors the daemon's host-metrics contract (see
 * `../../daemon/metrics/AGENTS.md`). Only the subset {@link computeSlotMapping}
 * (`./topology-slot-mapping.ts`) needs: no I/O, no identity-derivation
 * helpers, just the shape of a daemon-reported `topology-report` snapshot.
 *
 * Keep this file's field names, optionality, and doc comments aligned with
 * the daemon source — a drift here would silently reinterpret a stored
 * historical generation (`server-topology-records.ts`) differently than the
 * daemon that reported it.
 */

export type TopologyDeviceId = string // NOSONAR typescript:S6564 — opaque stable identity, never a kernel/interface name
export type FilesystemId = string // NOSONAR typescript:S6564 — opaque stable identity, never a mount path
export type GpuId = string // NOSONAR typescript:S6564 — opaque stable identity, never a PCI/kernel name
export type SignalId = string // NOSONAR typescript:S6564 — opaque stable identity, never a hwmon label

/**
 * Mirrors the daemon's `NetworkDeviceKind` — `uplink` (a hardware-backed NIC
 * or the topmost bond/bridge/team stacked on one; the only kind eligible as a
 * NIC slot), `member` (a port/nested aggregate under such an aggregate),
 * `virtual` (VLAN/macvlan children, tunnels — traffic rolls into an uplink),
 * `fabric`, `container-bridge`, `loopback`.
 */
export type NetworkDeviceKind =
  'uplink' | 'member' | 'virtual' | 'fabric' | 'container-bridge' | 'loopback'

/** Mirrors the daemon's `MAX_NIC_SLOTS` — the hard ceiling on monitored NIC slots per server. */
export const MAX_NIC_SLOTS = 8

export type NetworkDeviceIdentity = {
  mac?: string
  pciPath?: string
  virtualKey?: string
}

export type NetworkDeviceTopology = {
  deviceId: TopologyDeviceId
  kind: NetworkDeviceKind
  name: string
  identity: NetworkDeviceIdentity
  speedMbps?: number
  mtu?: number
  /** `true` on the one `uplink` carrying the host's default route; absent elsewhere and on pre-field snapshots. */
  defaultRoute?: boolean
}

export type FilesystemRole = 'root' | 'hosting' | 'docker' | 'application' | 'custom'

export type FilesystemTopology = {
  filesystemId: FilesystemId
  mountpoint: string
  fsType: string
  sourceDevice: string
  totalBytes: number | null
  totalInodes: number | null
  roles: FilesystemRole[]
}

export type BlockDeviceType = 'physical' | 'virtual' | 'partition'

export type BlockDeviceTopology = {
  deviceId: TopologyDeviceId
  kernelName: string
  model?: string
  serial?: string
  wwn?: string
  capacityBytes?: number
  deviceType: BlockDeviceType
  parentDeviceId?: TopologyDeviceId
  isServiceDevice: boolean
}

export type GpuKind = 'sysfs' | 'drm'

export type GpuTopology = {
  gpuId: GpuId
  kind: GpuKind
  pciPath: string
  vendor: string
  chip: string
}

/** Mirrors the daemon's `PhysicalSignalThresholds` (comment-3 extension). */
export type PhysicalSignalThresholds = {
  warning?: number
  critical?: number
}

export type PhysicalSignalTopology = {
  signalId: SignalId
  kind: string
  unit: string
  component: string
  label: string
  thresholds?: PhysicalSignalThresholds
}

export type CpuTopology = {
  sockets: number
  coresPerSocket: number
  threadsPerSocket: number
  model: string | null
}

export type NumaNodeTopology = {
  nodeId: string
  cpuIds: number[]
}

/** The daemon-reported `topology-report.snapshot` object, stored verbatim by `recordTopologyGeneration`. */
export type TopologySnapshot = {
  generation: number
  bootGeneration: number
  networks: NetworkDeviceTopology[]
  filesystems: FilesystemTopology[]
  blockDevices: BlockDeviceTopology[]
  gpus: GpuTopology[]
  hardwareSignals: PhysicalSignalTopology[]
  cpu: CpuTopology
  numaNodes: NumaNodeTopology[]
  memoryTotalBytes: number | null
  swapTotalBytes: number | null
}

/** Operator overrides projected into topology identity space — mirrors the daemon's `TopologyOverrides`. */
export type TopologyOverrides = {
  /**
   * The operator's monitored-NIC list in slot order (slot 1 first). Empty
   * means "auto" — only the default-route uplink is monitored. Non-empty is
   * the complete monitored set, deduplicated and capped at {@link MAX_NIC_SLOTS}.
   */
  nicSlotDeviceIds: TopologyDeviceId[]
  hostingFilesystemId: FilesystemId | null
  drivetempEnabled: boolean
}

export const EMPTY_TOPOLOGY_OVERRIDES: TopologyOverrides = {
  nicSlotDeviceIds: [],
  hostingFilesystemId: null,
  drivetempEnabled: false,
}

/** Pure slot-mapping output — see `./topology-slot-mapping.ts`. */
export type SlotMapping = {
  /**
   * Monitored normal-NIC slots in slot order (index 0 = slot 1), at most
   * {@link MAX_NIC_SLOTS}, no holes. Cloudflare embeds the first two in
   * `host.io`; any further slot pages as a standalone `network` row.
   */
  normalNicSlots: TopologyDeviceId[]
  fabricDeviceIds: TopologyDeviceId[]
  rootFilesystemId: FilesystemId | null
  gpuPageOrder: GpuId[]
  blockPageOrder: TopologyDeviceId[]
  filesystemPageOrder: FilesystemId[]
  hardwareSignalPageOrder: SignalId[]
}
