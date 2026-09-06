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
 * Keep in sync with the daemon source: a divergence here would let historical
 * slot reinterpretation drift between daemon generation assignment and
 * control-plane reconstruction.
 */
import {
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

  const filesystemIdsSorted = snapshot.filesystems.map((fs) => fs.filesystemId).sort(byId)
  const hostingOverride = overrides.hostingFilesystemId
  const filesystemPageOrder =
    hostingOverride && filesystemIdsSorted.includes(hostingOverride)
      ? [hostingOverride, ...filesystemIdsSorted.filter((id) => id !== hostingOverride)]
      : filesystemIdsSorted

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
