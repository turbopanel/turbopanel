import { assertEquals } from '@std/assert'
import { computeSlotMapping } from './topology-slot-mapping.ts'
import { EMPTY_TOPOLOGY_OVERRIDES, type TopologySnapshot } from './topology-types.ts'
import { buildTopologyInventoryV4, rootFilesystemTotalBytesV4 } from './topology-inventory.ts'

const test = Deno.test.bind(Deno)

function snapshot(overrides: Partial<TopologySnapshot> = {}): TopologySnapshot {
  return {
    generation: 0,
    bootGeneration: 0,
    networks: [
      {
        deviceId: 'mac:a',
        kind: 'uplink',
        name: 'eth0',
        identity: { mac: 'a' },
        speedMbps: 1000,
      },
      {
        deviceId: 'mac:b',
        kind: 'uplink',
        name: 'eth1',
        identity: { mac: 'b' },
      },
      { deviceId: 'virtual:fab1', kind: 'fabric', name: 'tp0', identity: {} },
      {
        deviceId: 'mac:c',
        kind: 'uplink',
        name: 'eth2',
        identity: { mac: 'c' },
      },
    ],
    filesystems: [
      {
        filesystemId: 'fs:root',
        mountpoint: '/',
        fsType: 'ext4',
        sourceDevice: '/dev/sda1',
        totalBytes: 1000,
        totalInodes: 1,
        roles: ['root'],
      },
      {
        filesystemId: 'fs:hosting',
        mountpoint: '/srv/users',
        fsType: 'xfs',
        sourceDevice: '/dev/sdb1',
        totalBytes: 2000,
        totalInodes: 1,
        roles: ['hosting'],
      },
    ],
    blockDevices: [
      {
        deviceId: 'sda',
        kernelName: 'sda',
        deviceType: 'physical',
        isServiceDevice: false,
      },
    ],
    gpus: [
      {
        gpuId: 'gpu0',
        kind: 'sysfs',
        pciPath: '0000:01:00.0',
        vendor: 'nvidia',
        chip: 'x',
      },
    ],
    hardwareSignals: [
      {
        signalId: 'psu1',
        kind: 'power',
        unit: 'watts',
        component: 'psu',
        label: 'PSU 1',
      },
    ],
    cpu: { sockets: 1, coresPerSocket: 4, threadsPerSocket: 8, model: 'x' },
    numaNodes: [],
    memoryTotalBytes: null,
    swapTotalBytes: null,
    ...overrides,
  }
}

test('buildTopologyInventoryV4: network role reflects SlotMapping (slot1/slot2/fabric/other)', () => {
  const snap = snapshot()
  const slotMapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  const inventory = buildTopologyInventoryV4(snap, slotMapping)

  const byId = new Map(inventory.networks.map((n) => [n.deviceId, n]))
  assertEquals(byId.get('mac:a')?.role, 'normalNicSlot1')
  assertEquals(byId.get('mac:b')?.role, 'normalNicSlot2')
  assertEquals(byId.get('virtual:fab1')?.role, 'fabric')
  assertEquals(byId.get('mac:c')?.role, 'other')
  assertEquals(byId.get('mac:a')?.speedMbps, 1000)
  assertEquals(byId.get('mac:b')?.speedMbps, undefined)
})

test('buildTopologyInventoryV4: filesystem isRoot matches SlotMapping.rootFilesystemId', () => {
  const snap = snapshot()
  const slotMapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  const inventory = buildTopologyInventoryV4(snap, slotMapping)

  const byId = new Map(inventory.filesystems.map((fs) => [fs.filesystemId, fs]))
  assertEquals(byId.get('fs:root')?.isRoot, true)
  assertEquals(byId.get('fs:hosting')?.isRoot, false)
})

test('buildTopologyInventoryV4: carries block/gpu/hardwareSignal identity + labels through', () => {
  const snap = snapshot()
  const slotMapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  const inventory = buildTopologyInventoryV4(snap, slotMapping)

  assertEquals(inventory.blockDevices, [
    {
      deviceId: 'sda',
      kernelName: 'sda',
      deviceType: 'physical',
      isServiceDevice: false,
    },
  ])
  assertEquals(inventory.gpus, [
    {
      gpuId: 'gpu0',
      kind: 'sysfs',
      vendor: 'nvidia',
      chip: 'x',
    },
  ])
  assertEquals(inventory.hardwareSignals, [
    { signalId: 'psu1', kind: 'power', unit: 'watts', label: 'PSU 1' },
  ])
})

test('rootFilesystemTotalBytesV4: resolves the root filesystem totalBytes', () => {
  const snap = snapshot()
  const slotMapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(rootFilesystemTotalBytesV4(snap, slotMapping), 1000)
})

test('rootFilesystemTotalBytesV4: null when no filesystem is marked root', () => {
  const snap = snapshot({
    filesystems: [
      {
        filesystemId: 'fs:hosting',
        mountpoint: '/srv/users',
        fsType: 'xfs',
        sourceDevice: '/dev/sdb1',
        totalBytes: 2000,
        totalInodes: 1,
        roles: ['hosting'],
      },
    ],
  })
  const slotMapping = computeSlotMapping(snap, EMPTY_TOPOLOGY_OVERRIDES)
  assertEquals(rootFilesystemTotalBytesV4(snap, slotMapping), null)
})
