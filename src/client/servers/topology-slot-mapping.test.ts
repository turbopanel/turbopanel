/**
 * Mirrors `turbopaneld/src/metrics/topology/slot-mapping.test.ts` verbatim —
 * same fixture, same expected outputs — proving the control-plane copy of
 * `computeSlotMapping` stays behaviorally aligned with the daemon's. If this
 * file's cases and the daemon's ever diverge, resync both by hand.
 */
import { assertEquals } from '@std/assert'
import { computeSlotMapping } from './topology-slot-mapping.ts'
import { EMPTY_TOPOLOGY_OVERRIDES, type TopologySnapshot } from './topology-types.ts'

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

test('computeSlotMapping: absent overrides fall back to the first two sorted uplinks, deterministic page orders', () => {
  const mapping = computeSlotMapping(snapshot(), EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(mapping.normalNicSlot1, 'mac:a')
  assertEquals(mapping.normalNicSlot2, 'mac:b')
  assertEquals(mapping.fabricDeviceIds, ['virtual:fab1'])
  assertEquals(mapping.rootFilesystemId, 'fs:dev:/dev/sda1')
  assertEquals(mapping.gpuPageOrder, ['pci:1', 'pci:2'])
  assertEquals(mapping.blockPageOrder, ['disk:a', 'disk:b'])
  assertEquals(mapping.filesystemPageOrder, ['fs:dev:/dev/sda1', 'fs:dev:/dev/sdb1'])
  assertEquals(mapping.hardwareSignalPageOrder, ['sig:a', 'sig:b'])
})

test('computeSlotMapping: same snapshot and overrides produce identical output on repeated calls', () => {
  const first = computeSlotMapping(snapshot(), EMPTY_TOPOLOGY_OVERRIDES)
  const second = computeSlotMapping(snapshot(), EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(first, second)
})

test('computeSlotMapping: an override reassigns only its own slot, never reorders the rest', () => {
  const withOverride = computeSlotMapping(snapshot(), {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    nicSlot1DeviceId: 'mac:b',
  })
  assertEquals(withOverride.normalNicSlot1, 'mac:b')
  assertEquals(withOverride.normalNicSlot2, 'mac:a')
  assertEquals(withOverride.fabricDeviceIds, ['virtual:fab1'])
  assertEquals(withOverride.gpuPageOrder, ['pci:1', 'pci:2'])
  assertEquals(withOverride.blockPageOrder, ['disk:a', 'disk:b'])
})

test('computeSlotMapping: a hostingFilesystemId override pins that filesystem first in the page order', () => {
  const mapping = computeSlotMapping(snapshot(), {
    ...EMPTY_TOPOLOGY_OVERRIDES,
    hostingFilesystemId: 'fs:dev:/dev/sdb1',
  })
  assertEquals(mapping.filesystemPageOrder, ['fs:dev:/dev/sdb1', 'fs:dev:/dev/sda1'])
})
