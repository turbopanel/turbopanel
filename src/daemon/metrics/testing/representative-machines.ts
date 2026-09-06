/**
 * Representative-machine fixture builders for the v4 metrics regression net.
 *
 * Sixteen machine shapes exercising every row-count-affecting dimension of
 * the v4 contract: NIC counts (embedded vs. paged vs. fabric-excluded), GPU
 * paging, presence-gated managed-service families (ingress/database-proxy),
 * bare-metal hardware signals, high-cardinality entity arrays (block
 * devices, filesystems, GPUs, NICs), and the two capability-gated detail
 * families (cpuDetail/memoryDetail).
 *
 * Each fixture pairs a `MetricsSampleV4Input`, the `MetricsCapabilityPlanV4`
 * that must entitle it (so a caller can round-trip through
 * `truncateSampleToCapabilityPlanV4` before packing — a plan that doesn't
 * grant enough slots would silently truncate the fixture's own entities),
 * and the `SlotMapping` that makes NIC/fabric/paging identity-addressed
 * rather than positional. `expectedFamilies` is the exact ordered
 * `blob2`/family multiset `buildMetricsDataPointsV4` emits (host.system,
 * host.io, gpu, network, filesystem, block, hardware.physical,
 * managed.ingress, managed.database_proxy, cpu.detail, memory.detail,
 * cpu.core.live, event — see `field-map-v4.ts`'s doc comment), and
 * `expectedRowCount` is that array's length.
 *
 * Pure data only — no `@std/*` imports — so this module stays safe to import
 * from anywhere in the metrics tree (Workers bundling included).
 */

import { METRICS_SCHEMA_VERSION_V4, type MetricsSampleV4Input } from '../contract-v4.ts'
import {
  type MetricsCapabilityPlanOverrideV4,
  type MetricsCapabilityPlanV4,
  resolveMetricsCapabilityPlan,
  type ServerMachineClass,
} from '../capability-plan.ts'
import type { HostedFamilyV4 } from '../metric-descriptors-v4.ts'
import type { SlotMapping } from '../types-v4.ts'

export type RepresentativeMachineFixture = {
  name: string
  input: MetricsSampleV4Input
  plan: MetricsCapabilityPlanV4
  slotMapping: SlotMapping
  expectedFamilies: HostedFamilyV4[]
  expectedRowCount: number
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function zeroHost(): MetricsSampleV4Input['host'] {
  return {
    cpu: {
      busyPercent: 0,
      userPercent: 0,
      systemPercent: 0,
      iowaitPercent: 0,
      stealPercent: 0,
      softirqPercent: 0,
      pressureSomePercent: 0,
      maxCoreBusyPercent: 0,
      procsRunning: 0,
      procsBlocked: 0,
    },
    kernel: { fileHandlesUsedPercent: 0, conntrackUsedPercent: 0 },
    memory: {
      availableBytes: 0,
      swapUsedBytes: 0,
      pressureSomePercent: 0,
      pressureFullPercent: 0,
      swapInBytesPerSecond: 0,
      swapOutBytesPerSecond: 0,
      majorPageFaultsPerSecond: 0,
    },
    storage: {
      ioPressureSomePercent: 0,
      ioPressureFullPercent: 0,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
      diskReadLatencyMs: 0,
      diskWriteLatencyMs: 0,
      maxBlockDeviceUtilPercent: 0,
      rootFilesystemAvailableBytes: 0,
      rootFilesystemFreeInodes: 0,
    },
    network: { tcpRetransmitPercent: 0, softnetDropsPerSecond: 0 },
  }
}

function baseMetadata(
  overrides: Partial<MetricsSampleV4Input['metadata']> = {}
): MetricsSampleV4Input['metadata'] {
  return {
    version: METRICS_SCHEMA_VERSION_V4,
    sampledAt: '2026-01-01T00:00:00.000Z',
    intervalSeconds: 60,
    sequence: 1,
    collectionMode: 'baseline',
    topologyGeneration: 1,
    bootGeneration: 1,
    ...overrides,
  }
}

function baseInput(overrides: Partial<MetricsSampleV4Input> = {}): MetricsSampleV4Input {
  return {
    metadata: baseMetadata(),
    host: zeroHost(),
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
    ...overrides,
  }
}

function emptySlotMapping(overrides: Partial<SlotMapping> = {}): SlotMapping {
  return {
    normalNicSlots: [],
    fabricDeviceIds: [],
    rootFilesystemId: null,
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
    ...overrides,
  }
}

function plan(
  machineClass: ServerMachineClass,
  overrides: MetricsCapabilityPlanOverrideV4 = {}
): MetricsCapabilityPlanV4 {
  return resolveMetricsCapabilityPlan(machineClass, undefined, overrides, 'hosted')
}

function nic(deviceId: string, seed = 1) {
  return {
    deviceId,
    receiveBytesPerSecond: seed,
    transmitBytesPerSecond: seed + 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

function gpu(gpuId: string, seed = 1) {
  return {
    gpuId,
    utilizationPercent: seed,
    memoryUsedBytes: seed,
    memoryActivityPercent: seed,
    temperatureCelsius: seed,
    memoryTemperatureCelsius: seed,
    powerWatts: seed,
    pcieReceiveBytesPerSecond: seed,
    pcieTransmitBytesPerSecond: seed,
    throttlePercent: 0,
  }
}

function filesystem(filesystemId: string, seed = 1) {
  return { filesystemId, availableBytes: seed, freeInodes: seed }
}

function blockDevice(deviceId: string, seed = 1) {
  return {
    deviceId,
    readBytesPerSecond: seed,
    writeBytesPerSecond: seed,
    readOpsPerSecond: seed,
    writeOpsPerSecond: seed,
    readLatencyMs: seed,
    writeLatencyMs: seed,
    utilizationPercent: 0,
    temperatureCelsius: seed,
    queueDepth: seed,
  }
}

function hardwareSignal(signalId: string, seed = 1) {
  return { signalId, kind: 'temp', value: seed }
}

function ingressSource(sourceId: string, seed = 1) {
  return {
    sourceId,
    sourceKind: 'caddy',
    requests: seed,
    responses2xx: seed,
    responses3xx: 0,
    responses4xx: 0,
    responses5xx: 0,
    requestErrors: 0,
    requestBytes: seed,
    responseBytes: seed,
    requestDurationSecondsAvg: 0.1,
    requestsUnder100ms: seed,
    requestsUnder500ms: seed,
    requestsUnder1s: seed,
    requestsUnder5s: seed,
    requestsInFlight: 1,
    upstreamsHealthy: 1,
    upstreamsTotal: 1,
    retries: 0,
  }
}

function databaseProxy(sourceId: string, seed = 1) {
  return {
    sourceId,
    sourceKind: 'proxysql',
    queries: seed,
    slowQueries: 0,
    connectionErrors: 0,
    clientConnections: seed,
    backendConnections: seed,
    backendsUp: 1,
  }
}

function cpuHotspot(coreId: string, seed = 1) {
  return { coreId, busyPercent: seed, iowaitPercent: seed, stealPercent: 0 }
}

function cpuDetail(): NonNullable<MetricsSampleV4Input['cpuDetail']> {
  return {
    hotspots: Array.from({ length: 4 }, (_, i) => cpuHotspot(`cpu${i}`, i)),
    averageFrequencyMHz: 2000,
    minimumFrequencyMHz: 1000,
    maximumFrequencyMHz: 3000,
    contextSwitchesPerSecond: 1,
    interruptsPerSecond: 1,
    forksPerSecond: 1,
    cpuIrqPercent: 1,
  }
}

function memoryDetail(): NonNullable<MetricsSampleV4Input['memoryDetail']> {
  return {
    memoryFreeBytes: 1,
    cachedBytes: 1,
    anonPagesBytes: 1,
    slabReclaimableBytes: 1,
    slabUnreclaimableBytes: 1,
    dirtyBytes: 1,
    writebackBytes: 1,
    shmemBytes: 1,
    pageTablesBytes: 1,
    kernelStackBytes: 1,
    committedAsBytes: 1,
    commitLimitBytes: 1,
    activeAnonBytes: 1,
    inactiveAnonBytes: 1,
    activeFileBytes: 1,
    inactiveFileBytes: 1,
    pageScanDirectPerSecond: 1,
    pageScanKswapdPerSecond: 1,
    compactionStallsPerSecond: 1,
  }
}

const HOST_BASE_FAMILIES: HostedFamilyV4[] = ['host.system', 'host.io']

function ids(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`)
}

// ---------------------------------------------------------------------------
// 1. 1-NIC VM
// ---------------------------------------------------------------------------

function oneNicVm(): RepresentativeMachineFixture {
  return {
    name: '1-nic-vm',
    input: baseInput({ networks: [nic('eth0')] }),
    plan: plan('virtual'),
    slotMapping: emptySlotMapping({ normalNicSlots: ['eth0'] }),
    expectedFamilies: [...HOST_BASE_FAMILIES],
    expectedRowCount: 2,
  }
}

// ---------------------------------------------------------------------------
// 2. 2-NIC VM
// ---------------------------------------------------------------------------

function twoNicVm(): RepresentativeMachineFixture {
  return {
    name: '2-nic-vm',
    input: baseInput({ networks: [nic('eth0'), nic('eth1', 2)] }),
    plan: plan('virtual'),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES],
    expectedRowCount: 2,
  }
}

// ---------------------------------------------------------------------------
// 3. 2-NIC + TurboFabric VM
// ---------------------------------------------------------------------------

function twoNicFabricVm(): RepresentativeMachineFixture {
  return {
    name: '2-nic-fabric-vm',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2), nic('fabric0', 3)],
    }),
    plan: plan('virtual', { turboFabricEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      fabricDeviceIds: ['fabric0'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES],
    expectedRowCount: 2,
  }
}

// ---------------------------------------------------------------------------
// 4. 1-GPU VM
// ---------------------------------------------------------------------------

function oneGpuVm(): RepresentativeMachineFixture {
  return {
    name: '1-gpu-vm',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      gpus: [gpu('gpu0')],
    }),
    plan: plan('virtual', { gpuSlots: 1 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'gpu'],
    expectedRowCount: 3,
  }
}

// ---------------------------------------------------------------------------
// 5. Web VM (Caddy ingress source)
// ---------------------------------------------------------------------------

function webVm(): RepresentativeMachineFixture {
  return {
    name: 'web-vm',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      ingressSources: [ingressSource('caddy0')],
    }),
    plan: plan('virtual', { managedIngressEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'managed.ingress'],
    expectedRowCount: 3,
  }
}

// ---------------------------------------------------------------------------
// 6. Web + GPU VM
// ---------------------------------------------------------------------------

function webGpuVm(): RepresentativeMachineFixture {
  return {
    name: 'web-gpu-vm',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      gpus: [gpu('gpu0')],
      ingressSources: [ingressSource('caddy0')],
    }),
    plan: plan('virtual', { gpuSlots: 1, managedIngressEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'gpu', 'managed.ingress'],
    expectedRowCount: 4,
  }
}

// ---------------------------------------------------------------------------
// 7. DB-only VM (no proxy sidecar reporting)
// ---------------------------------------------------------------------------

function dbOnlyVm(): RepresentativeMachineFixture {
  return {
    name: 'db-only-vm',
    input: baseInput({ networks: [nic('eth0'), nic('eth1', 2)] }),
    plan: plan('virtual', { databaseProxyMetricsEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES],
    expectedRowCount: 2,
  }
}

// ---------------------------------------------------------------------------
// 8. DB + ProxySQL VM
// ---------------------------------------------------------------------------

function dbProxySqlVm(): RepresentativeMachineFixture {
  return {
    name: 'db-proxysql-vm',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      databaseProxies: [databaseProxy('proxysql0')],
    }),
    plan: plan('virtual', { databaseProxyMetricsEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'managed.database_proxy'],
    expectedRowCount: 3,
  }
}

// ---------------------------------------------------------------------------
// 9. Bare-metal, <=19 hardware signals
// ---------------------------------------------------------------------------

function bareMetalLowSignals(): RepresentativeMachineFixture {
  const signalIds = ids(10, 'sig')
  return {
    name: 'bare-metal-low-signals',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      hardwareSignals: signalIds.map((id, i) => hardwareSignal(id, i)),
    }),
    plan: plan('physical'),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      hardwareSignalPageOrder: [...signalIds].sort((a, b) => a.localeCompare(b)),
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'hardware.physical'],
    expectedRowCount: 3,
  }
}

// ---------------------------------------------------------------------------
// 10. Bare-metal + GPU
// ---------------------------------------------------------------------------

function bareMetalGpu(): RepresentativeMachineFixture {
  const signalIds = ids(10, 'sig')
  return {
    name: 'bare-metal-gpu',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      gpus: [gpu('gpu0')],
      hardwareSignals: signalIds.map((id, i) => hardwareSignal(id, i)),
    }),
    plan: plan('physical', { gpuSlots: 1 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0'],
      hardwareSignalPageOrder: [...signalIds].sort((a, b) => a.localeCompare(b)),
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'gpu', 'hardware.physical'],
    expectedRowCount: 4,
  }
}

// ---------------------------------------------------------------------------
// 11. 4-NIC host, all four monitored on a 4-slot plan (2 embedded + 2 paged
//     -> 1 network page). An unmonitored NIC never reaches the store at all
//     (`truncateSampleToCapabilityPlanV4`), so only monitored slots page.
// ---------------------------------------------------------------------------

function fourNic(): RepresentativeMachineFixture {
  const extra = ids(2, 'ethX')
  return {
    name: '4-nic',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2), ...extra.map((id, i) => nic(id, 10 + i))],
    }),
    plan: plan('virtual', { normalNicSlots: 4 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1', ...extra],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'network'],
    expectedRowCount: 3,
  }
}

// ---------------------------------------------------------------------------
// 12. 8-NIC host, all eight monitored on an 8-slot (self-hosted ceiling) plan
//     (2 embedded + 6 paged -> 2 network pages)
// ---------------------------------------------------------------------------

function eightNic(): RepresentativeMachineFixture {
  const extra = ids(6, 'ethX')
  return {
    name: '8-nic',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2), ...extra.map((id, i) => nic(id, 10 + i))],
    }),
    plan: plan('virtual', { normalNicSlots: 8 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1', ...extra],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'network', 'network'],
    expectedRowCount: 4,
  }
}

// ---------------------------------------------------------------------------
// 13. 16-GPU host (ceil(16/2) = 8 pages)
// ---------------------------------------------------------------------------

function sixteenGpu(): RepresentativeMachineFixture {
  const gpuIds = ids(16, 'gpu')
  return {
    name: '16-gpu',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      gpus: gpuIds.map((id, i) => gpu(id, i)),
    }),
    plan: plan('physical', { gpuSlots: 16 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: [...gpuIds].sort((a, b) => a.localeCompare(b)),
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, ...new Array(8).fill('gpu')],
    expectedRowCount: 10,
  }
}

// ---------------------------------------------------------------------------
// 14. 24-block-device host (ceil(24/2) = 12 pages)
// ---------------------------------------------------------------------------

function twentyFourBlockDevices(): RepresentativeMachineFixture {
  const deviceIds = ids(24, 'sd')
  return {
    name: '24-block-devices',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      blockDevices: deviceIds.map((id, i) => blockDevice(id, i)),
    }),
    plan: plan('physical', { detailedBlockDeviceSlots: 24 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      blockPageOrder: [...deviceIds].sort((a, b) => a.localeCompare(b)),
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, ...new Array(12).fill('block')],
    expectedRowCount: 14,
  }
}

// ---------------------------------------------------------------------------
// 15. 12-extra-filesystem host (ceil(12/9) = 2 pages)
// ---------------------------------------------------------------------------

function twelveExtraFilesystems(): RepresentativeMachineFixture {
  const filesystemIds = ids(12, 'fs')
  return {
    name: '12-extra-filesystems',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      filesystems: filesystemIds.map((id, i) => filesystem(id, i)),
    }),
    plan: plan('virtual', { extraFilesystemSlots: 12 }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      filesystemPageOrder: [...filesystemIds].sort((a, b) => a.localeCompare(b)),
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'filesystem', 'filesystem'],
    expectedRowCount: 4,
  }
}

// ---------------------------------------------------------------------------
// 16. Large-CPU/RAM host (cpuDetail + memoryDetail enabled)
// ---------------------------------------------------------------------------

function largeCpuRam(): RepresentativeMachineFixture {
  return {
    name: 'large-cpu-ram',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      cpuDetail: cpuDetail(),
      memoryDetail: memoryDetail(),
    }),
    plan: plan('virtual', {
      cpuDetailEnabled: true,
      memoryDetailEnabled: true,
    }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'cpu.detail', 'memory.detail'],
    expectedRowCount: 4,
  }
}

/** All 16 representative-machine fixtures, in the order documented in the plan. */
export function representativeMachineFixtures(): RepresentativeMachineFixture[] {
  return [
    oneNicVm(),
    twoNicVm(),
    twoNicFabricVm(),
    oneGpuVm(),
    webVm(),
    webGpuVm(),
    dbOnlyVm(),
    dbProxySqlVm(),
    bareMetalLowSignals(),
    bareMetalGpu(),
    fourNic(),
    eightNic(),
    sixteenGpu(),
    twentyFourBlockDevices(),
    twelveExtraFilesystems(),
    largeCpuRam(),
  ]
}
