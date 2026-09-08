/**
 * Control-plane mirror of `turbopaneld/src/metrics/topology/slot-mapping.ts`
 * — same pure function, verbatim logic, kept behaviorally aligned by
 * `topology-slot-mapping.test.ts` (mirrors the daemon's own test cases). No
 * I/O, so the daemon and control plane can reconstruct the identical
 * `SlotMapping` from the same `(TopologySnapshot, TopologyOverrides)` pair —
 * the shared contract the packer/query-reconstruction layer depends on.
 *
 * Normal-NIC slot rule: an operator list (`overrides.nicSlotDeviceIds`) wins
 * outright — the complete monitored set in slot order, deduplicated, capped
 * at `MAX_NIC_SLOTS`, ids kept even when absent from this snapshot. Otherwise
 * exactly one slot: the `uplink` flagged `defaultRoute`, falling back to the
 * first uplink by sorted id. Nothing else is monitored by default.
 *
 * Filesystem page-order rule (see {@link FILESYSTEM_ROLE_PRIORITY}): every
 * role-bearing filesystem is pinned ahead of the rest, in a fixed role
 * priority, with an operator `hostingFilesystemId` override taking the very
 * first slot; everything else follows sorted by id.
 *
 * Keep in sync with the daemon source: a divergence here would let historical
 * slot reinterpretation drift between daemon generation assignment and
 * control-plane reconstruction.
 */
import {
  type FilesystemRole,
  MAX_NIC_SLOTS,
  type SlotMapping,
  type TopologyOverrides,
  type TopologySnapshot,
} from './topology-types.ts'

function byId(a: string, b: string): number {
  return a.localeCompare(b)
}

/** Operator list, deduplicated in first-seen order and capped at `MAX_NIC_SLOTS`. */
function normalizeNicSlotList(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_NIC_SLOTS) break
  }
  return out
}

/** The auto-selected primary: the default-route uplink, else the first uplink by sorted id. */
function resolveDefaultNicSlots(networks: TopologySnapshot['networks']): string[] {
  const uplinks = networks.filter((device) => device.kind === 'uplink')
  const gateway = uplinks.find((device) => device.defaultRoute === true)
  if (gateway) return [gateway.deviceId]
  const sorted = uplinks.map((device) => device.deviceId).sort(byId)
  return sorted.length > 0 ? [sorted[0]!] : []
}

/**
 * Role pinning order for {@link resolveFilesystemPageOrder}. Most-rendered
 * first: `/` and the hosting root are on every storage panel, the Docker data
 * root and the backup root are what a full-disk incident is usually about,
 * and the log directory trails them. `application`/`custom` are deliberately
 * absent — they are operator-labelled mounts with no fixed product meaning,
 * so they sort with everything else rather than displacing a role the panel
 * always shows.
 */
const FILESYSTEM_ROLE_PRIORITY: readonly FilesystemRole[] = [
  'root',
  'hosting',
  'docker',
  'backup',
  'logs',
]

/**
 * Role-bearing filesystems first (in {@link FILESYSTEM_ROLE_PRIORITY} order,
 * ties broken by id), then everything else by id.
 *
 * An operator `hostingFilesystemId` override takes the very first slot when
 * it names a filesystem this snapshot actually has — it is an explicit
 * statement about which filesystem *is* the hosting one, so it outranks the
 * discovered roles rather than being merged with them. One filesystem
 * carrying several roles (a single-disk host where `/`, hosting and Docker
 * are all the same device) still appears exactly once, at its highest role's
 * position.
 */
function resolveFilesystemPageOrder(
  filesystems: TopologySnapshot['filesystems'],
  hostingOverride: string | null | undefined
): string[] {
  const allSorted = filesystems.map((fs) => fs.filesystemId).sort(byId)
  const known = new Set(allSorted)
  const pinned: string[] = []
  const pin = (id: string | null | undefined): void => {
    if (!id || !known.has(id) || pinned.includes(id)) return
    pinned.push(id)
  }

  pin(hostingOverride)
  for (const role of FILESYSTEM_ROLE_PRIORITY) {
    for (const id of filesystems
      .filter((fs) => fs.roles.includes(role))
      .map((fs) => fs.filesystemId)
      .sort(byId)) {
      pin(id)
    }
  }

  return [...pinned, ...allSorted.filter((id) => !pinned.includes(id))]
}

export function computeSlotMapping(
  snapshot: TopologySnapshot,
  overrides: TopologyOverrides
): SlotMapping {
  const explicit = normalizeNicSlotList(overrides.nicSlotDeviceIds)
  const normalNicSlots = explicit.length > 0 ? explicit : resolveDefaultNicSlots(snapshot.networks)

  const fabricDeviceIds = snapshot.networks
    .filter((device) => device.kind === 'fabric')
    .map((device) => device.deviceId)
    .sort(byId)

  const rootFilesystemId =
    snapshot.filesystems.find((fs) => fs.roles.includes('root'))?.filesystemId ?? null

  const filesystemPageOrder = resolveFilesystemPageOrder(
    snapshot.filesystems,
    overrides.hostingFilesystemId
  )

  const blockPageOrder = snapshot.blockDevices.map((device) => device.deviceId).sort(byId)
  const gpuPageOrder = snapshot.gpus.map((gpu) => gpu.gpuId).sort(byId)
  const hardwareSignalPageOrder = snapshot.hardwareSignals
    .map((signal) => signal.signalId)
    .sort(byId)

  return {
    normalNicSlots,
    fabricDeviceIds,
    rootFilesystemId,
    gpuPageOrder,
    blockPageOrder,
    filesystemPageOrder,
    hardwareSignalPageOrder,
  }
}
