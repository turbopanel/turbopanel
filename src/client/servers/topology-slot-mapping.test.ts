/**
 * Mirrors `turbopaneld/src/metrics/topology/slot-mapping.test.ts` verbatim —
 * same fixture, same expected outputs — proving the control-plane copy of
 * `computeSlotMapping` stays behaviorally aligned with the daemon's. If this
 * file's cases and the daemon's ever diverge, resync both by hand.
 */
import { assertEquals } from '@std/assert'
import { computeSlotMapping } from './topology-slot-mapping.ts'
import { EMPTY_TOPOLOGY_OVERRIDES, MAX_NIC_SLOTS, type TopologySnapshot } from './topology-types.ts'

const test = Deno.test.bind(Deno)

function snapshot(overrides: Partial<TopologySnapshot> = {}): TopologySnapshot {
  return {
    generation: 0,
    bootGeneration: 0,
    networks: [
      {
        deviceId: 'mac:b',
        kind: 'uplink',
        name: 'eth1',
        identity: { mac: 'b' },
      },
      {
        deviceId: 'mac:a',
        kind: 'uplink',
        name: 'eth0',
        identity: { mac: 'a' },
      },
      { deviceId: 'virtual:fab1', kind: 'fabric', name: 'tp0', identity: {} },
    ],
    filesystems: [
      {
        filesystemId: 'fs:dev:/dev/sda1',
        mountpoint: '/',
        fsType: 'ext4',
        sourceDevice: '/dev/sda1',
        totalBytes: 1,
        totalInodes: 1,
        roles: ['root'],
      },
      {
        filesystemId: 'fs:dev:/dev/sdb1',
        mountpoint: '/srv/users',
        fsType: 'xfs',
        sourceDevice: '/dev/sdb1',
        totalBytes: 1,
        totalInodes: 1,
        roles: ['hosting'],
      },
    ],
    blockDevices: [
      {
        deviceId: 'disk:b',
        kernelName: 'sdb',
        deviceType: 'physical',
        isServiceDevice: true,
      },
      {
        deviceId: 'disk:a',
        kernelName: 'sda',
        deviceType: 'physical',
        isServiceDevice: true,
      },
    ],
    gpus: [
      {
        gpuId: 'pci:2',
        kind: 'drm',
        pciPath: '2',
        vendor: 'amd',
        chip: 'amdgpu',
      },
      {
        gpuId: 'pci:1',
        kind: 'drm',
        pciPath: '1',
        vendor: 'intel',
        chip: 'i915',
      },
    ],
    hardwareSignals: [
      {
        signalId: 'sig:b',
        kind: 'fan',
        unit: 'rpm',
        component: 'chassis',
        label: 'Fan 2',
      },
      {
        signalId: 'sig:a',
        kind: 'fan',
        unit: 'rpm',
        component: 'chassis',
        label: 'Fan 1',
      },
    ],
    cpu: {
      sockets: 1,
      coresPerSocket: 4,
      threadsPerSocket: 8,
      model: 'Test CPU',
    },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
    ...overrides,
  }
}

test('computeSlotMapping: absent overrides monitor only the first sorted uplink when no default route is flagged, deterministic page orders', () => {
  const mapping = computeSlotMapping(snapshot(), EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(mapping.normalNicSlots, ['mac:a'])
  assertEquals(mapping.fabricDeviceIds, ['virtual:fab1'])
  assertEquals(mapping.rootFilesystemId, 'fs:dev:/dev/sda1')
  assertEquals(mapping.gpuPageOrder, ['pci:1', 'pci:2'])
  assertEquals(mapping.blockPageOrder, ['disk:a', 'disk:b'])
  assertEquals(mapping.filesystemPageOrder, ['fs:dev:/dev/sda1', 'fs:dev:/dev/sdb1'])
  assertEquals(mapping.hardwareSignalPageOrder, ['sig:a', 'sig:b'])
})

test('computeSlotMapping: the default-route uplink is the auto primary even when it sorts later', () => {
  const snap = snapshot()
  snap.networks = snap.networks.map((device) =>
    device.deviceId === 'mac:b' ? { ...device, defaultRoute: true } : device
  )
  const mapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(mapping.normalNicSlots, ['mac:b'])
})

test('computeSlotMapping: a default-route flag on a non-uplink device is ignored', () => {
  const snap = snapshot()
  snap.networks = [
    ...snap.networks,
    {
      deviceId: 'virtual:vlan',
      kind: 'virtual',
      name: 'eth0.100',
      identity: { virtualKey: 'vlan' },
      defaultRoute: true,
    },
  ]
  const mapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(mapping.normalNicSlots, ['mac:a'])
})

test('computeSlotMapping: no uplink at all yields no normal NIC slots', () => {
  const snap = snapshot()
  snap.networks = snap.networks.filter((device) => device.kind !== 'uplink')
  const mapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(mapping.normalNicSlots, [])
  assertEquals(mapping.fabricDeviceIds, ['virtual:fab1'])
})

test('computeSlotMapping: same snapshot and overrides produce identical output on repeated calls', () => {
  const first = computeSlotMapping(snapshot(), EMPTY_TOPOLOGY_OVERRIDES)
  const second = computeSlotMapping(snapshot(), EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(first, second)
})

test('computeSlotMapping: an operator list is the complete monitored set in slot order and never reorders the rest', () => {
  const withOverride = computeSlotMapping(snapshot(), {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlotDeviceIds: ['mac:b', 'mac:a'],
  })
  assertEquals(withOverride.normalNicSlots, ['mac:b', 'mac:a'])
  assertEquals(withOverride.fabricDeviceIds, ['virtual:fab1'])
  assertEquals(withOverride.gpuPageOrder, ['pci:1', 'pci:2'])
  assertEquals(withOverride.blockPageOrder, ['disk:a', 'disk:b'])
})

test('computeSlotMapping: an operator list keeps a pinned id absent from this snapshot, drops duplicates and blanks, and caps at MAX_NIC_SLOTS', () => {
  const ids = Array.from({ length: MAX_NIC_SLOTS + 2 }, (_, i) => `mac:x${i}`)
  const mapping = computeSlotMapping(snapshot(), {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlotDeviceIds: ['mac:gone', '', 'mac:gone', ...ids],
  })
  assertEquals(mapping.normalNicSlots.length, MAX_NIC_SLOTS)
  assertEquals(mapping.normalNicSlots[0], 'mac:gone')
  assertEquals(mapping.normalNicSlots[1], 'mac:x0')
})

test('computeSlotMapping: a hostingFilesystemId override pins that filesystem first in the page order', () => {
  const mapping = computeSlotMapping(snapshot(), {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    hostingFilesystemId: 'fs:dev:/dev/sdb1',
  })
  assertEquals(mapping.filesystemPageOrder, ['fs:dev:/dev/sdb1', 'fs:dev:/dev/sda1'])
})
