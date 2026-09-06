/**
 * Control-plane mirror of `turbopaneld/src/metrics/topology/slot-mapping.ts`
 * — same pure function, verbatim logic, kept behaviorally aligned by
 * `topology-slot-mapping.test.ts` (mirrors the daemon's own test cases). No
 * I/O, so the daemon and control plane can reconstruct the identical
 * `SlotMapping` from the same `(TopologySnapshot, TopologyOverrides)` pair —
 * the shared contract later packer/query-reconstruction work depends on.
 *
 * Keep in sync with the daemon source: a divergence here would let historical
 * slot reinterpretation drift between daemon generation assignment and
 * control-plane reconstruction.
 */
import type { SlotMapping, TopologyOverrides, TopologySnapshot } from './topology-types.ts'

function byId(a: string, b: string): number {
  return a.localeCompare(b)
}

/** Explicit override wins outright; otherwise the first sorted uplink not already claimed by the other slot. */
function resolveNicSlot(
  overrideId: string | null,
  uplinkIdsSorted: string[],
  claimedByOtherSlot: string | null
): string | null {
  if (overrideId) return overrideId
  return uplinkIdsSorted.find((id) => id !== claimedByOtherSlot) ?? null
}

export function computeSlotMapping(
  snapshot: TopologySnapshot,
  overrides: TopologyOverrides
): SlotMapping {
  const uplinkIdsSorted = snapshot.networks
    .filter((device) => device.kind === 'uplink')
    .map((device) => device.deviceId)
    .sort(byId)

  const normalNicSlot1 = resolveNicSlot(overrides.nicSlot1DeviceId, uplinkIdsSorted, null)
  const normalNicSlot2 = resolveNicSlot(overrides.nicSlot2DeviceId, uplinkIdsSorted, normalNicSlot1)

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
    normalNicSlot1,
    normalNicSlot2,
    fabricDeviceIds,
    rootFilesystemId,
    gpuPageOrder,
    blockPageOrder,
    filesystemPageOrder,
    hardwareSignalPageOrder,
  }
}
