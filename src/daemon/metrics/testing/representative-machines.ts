/**
 * Representative-machine fixture builders for the v5 metrics regression net.
 *
 * Nineteen machine shapes exercising every row-count-affecting dimension of
 * the v5 contract: NIC counts (embedded vs. paged vs. fabric-excluded), GPU
 * paging, presence-gated managed-service families (ingress/database-proxy),
 * bare-metal hardware signals, high-cardinality entity arrays (block
 * devices, filesystems, GPUs, NICs), the merged always-on depth family
 * (`diagnostics`), and the two host-wide storage families
 * (`managed.storage`, always on; `managed.docker`, gated by
 * `managedDockerEnabled` — covered both on and off).
 *
 * Each fixture pairs a `MetricsSampleInput`, the `MetricsCapabilityPlan`
 * that must entitle it (so a caller can round-trip through
 * `truncateSampleToCapabilityPlan` before packing — a plan that doesn't
 * grant enough slots would silently truncate the fixture's own entities),
 * and the `SlotMapping` that makes NIC/fabric/paging identity-addressed
 * rather than positional. `expectedFamilies` is the exact ordered
 * `blob2`/family multiset `buildMetricsDataPoints` emits (host.system,
 * host.io, gpu, network, filesystem, block, hardware.physical,
 * managed.ingress, managed.database_proxy, managed.router, managed.storage,
 * managed.docker, host.diagnostics, event — see
 * `field-map.ts`'s doc comment), and
 * `expectedRowCount` is that array's length.
 *
 * Pure data only — no `@std/*` imports — so this module stays safe to import
 * from anywhere in the metrics tree (Workers bundling included).
 */

import { METRICS_SCHEMA_VERSION, type MetricsSampleInput } from '../contract.ts'
import {
  type MetricsCapabilityPlanOverride,
  type MetricsCapabilityPlan,
  resolveMetricsCapabilityPlan,
  type ServerMachineClass,
} from '../capability-plan.ts'
import type { HostedFamily } from '../metric-descriptors.ts'
import type { SlotMapping } from '../types.ts'

export type RepresentativeMachineFixture = {
  name: string
  input: MetricsSampleInput
  plan: MetricsCapabilityPlan
  slotMapping: SlotMapping
  expectedFamilies: HostedFamily[]
  expectedRowCount: number
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function zeroHost(): MetricsSampleInput['host'] {
  return {
    cpu: {
      busyPercent: 0,
      userPercent: 0,
      systemPercent: 0,
      iowaitPercent: 0,
      stealPercent: 0,
      softirqPercent: 0,
      pressureSomePercent: 0,
      saturatedCoreCount: 0,
      procsRunning: 0,
      procsBlocked: 0,
      processCount: 0,
    },
    kernel: { fileHandlesUsedPercent: 0, conntrackUsedPercent: 0 },
    memory: {
      usedBytes: 0,
      cachedFilesBytes: null,
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
      diskLatencyMs: 0,
      rootFilesystemAvailableBytes: 0,
      rootFilesystemFreeInodes: 0,
    },
    network: { tcpRetransmitPercent: 0, softnetDropsPerSecond: 0 },
  }
}

function baseMetadata(
  overrides: Partial<MetricsSampleInput['metadata']> = {}
): MetricsSampleInput['metadata'] {
  return {
    version: METRICS_SCHEMA_VERSION,
    sampledAt: '2026-01-01T00:00:00.000Z',
    intervalSeconds: 60,
    sequence: 1,
    topologyGeneration: 1,
    bootGeneration: 1,
    ...overrides,
  }
}

function baseInput(overrides: Partial<MetricsSampleInput> = {}): MetricsSampleInput {
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
  overrides: MetricsCapabilityPlanOverride = {}
): MetricsCapabilityPlan {
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
    queueDepth: seed,
  }
}

function hardwareSignal(signalId: string, seed = 1, kind = 'temperature') {
  return { signalId, kind, value: seed }
}

/**
 * The three entity-joined `hardware.physical` signal ids one GPU contributes
 * — GPU temperature, memory temperature and power moved off `GpuSample` and
 * onto `hardwareSignals`, so a GPU-bearing bare-metal host grows this family
 * by 3 per GPU. Id shape mirrors the daemon's `gpuSignalId`
 * (`signal:gpu:<gpuId>:<kind>`), which is resolved by exact-id lookup only.
 */
function gpuSignalIds(gpuId: string): string[] {
  return ['temperature', 'memory-temperature', 'power'].map((kind) => `signal:gpu:${gpuId}:${kind}`)
}

/**
 * The one entity-joined `hardware.physical` signal id a *service* block
 * device contributes — drive temperature moved off `BlockDeviceSample`, so a
 * drive-bearing bare-metal host grows this family by 1 per service drive. Id
 * shape mirrors the daemon's `blockTemperatureSignalId`
 * (`signal:block:<deviceId>:temperature`).
 */
function blockSignalId(deviceId: string): string {
  return `signal:block:${deviceId}:temperature`
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b))
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
    requestDurationSecondsSum: 0.1 * seed,
    // Cumulative-`le` buckets: every bound counts the same one request, so
    // the fixture stays monotonic the way a real exposition is.
    bucket10ms: 0,
    bucket50ms: 0,
    bucket100ms: seed,
    bucket500ms: seed,
    bucket1s: seed,
    bucket5s: seed,
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
    queryLatencyMsAvg: 2,
    backendLatencyMsAvg: 1,
    activeTransactions: 0,
    clientConnections: seed,
    clientConnectionsCreated: seed,
    clientConnectionsAborted: 0,
    connectionsRejectedMaxConns: 0,
    backendConnections: seed,
    backendConnectionsCreated: seed,
    backendConnectionsAborted: 0,
    connectionErrors: 0,
    backendsUp: 1,
    backendsTotal: 1,
    bytesFromBackends: seed,
    bytesToBackends: seed,
  }
}

/** The host-wide shared-ingress router singleton — no entity id, like `diagnostics()`. */
function routerSample(): NonNullable<MetricsSampleInput['router']> {
  return {
    backendsUp: 1,
    backendsTotal: 1,
    servicesTotal: 1,
    routersTotal: 1,
    retries: 0,
    backendErrors5xx: 0,
    backendLatencyMsAvg: 3,
    backendRequests: 1,
    httpOpenConnections: 1,
    configReloads: 0,
    configLastReloadAgeSeconds: 60,
    tlsCertSoonestExpiryDays: 45,
  }
}

/**
 * The host-wide managed-storage singleton — no entity id, like
 * `routerSample()`. The twelve per-engine census readings stay `null`: no
 * collector populates them yet (see `StorageSample`'s doc comment), and a
 * fixture that invented numbers would assert a shape the daemon never sends.
 */
function storageSample(): NonNullable<MetricsSampleInput['storage']> {
  const engine = {
    instancesRunning: null,
    instancesHealthy: null,
    connectionsUsed: null,
    connectionsMax: null,
  }
  return {
    hostingUsedBytes: 4096,
    backupUsedBytes: 2048,
    dockerUsedBytes: 8192,
    logsUsedBytes: 512,
    hostingFreeBytes: 1_000_000,
    backupFreeBytes: 2_000_000,
    logsFreeBytes: 3_000_000,
    postgres: { ...engine },
    mysql: { ...engine },
    mariadb: { ...engine },
  }
}

/** Docker's `GET /system/df` breakdown — gated by `managedDockerEnabled`. */
function dockerUsageSample(): NonNullable<MetricsSampleInput['dockerUsage']> {
  return {
    layersBytes: 6000,
    imagesCount: 4,
    imagesReclaimableBytes: 1000,
    containersBytes: 1200,
    containersCount: 3,
    volumesBytes: 900,
    volumesCount: 2,
    volumesReclaimableBytes: 100,
    buildCacheBytes: 92,
    buildCacheReclaimableBytes: 92,
  }
}

function diagnostics(): NonNullable<MetricsSampleInput['diagnostics']> {
  return {
    cpu: {
      averageFrequencyMHz: 2000,
      minimumFrequencyMHz: 1000,
      maximumFrequencyMHz: 3000,
      contextSwitchesPerSecond: 1,
      interruptsPerSecond: 1,
      forksPerSecond: 1,
      cpuIrqPercent: 1,
    },
    memory: {
      memoryFreeBytes: 1,
      cachedBytes: 1,
      anonPagesBytes: 1,
      slabReclaimableBytes: 1,
      slabUnreclaimableBytes: 1,
      dirtyBytes: 1,
      writebackBytes: 1,
      shmemBytes: 1,
      committedAsBytes: 1,
      pageScanDirectPerSecond: 1,
      pageScanKswapdPerSecond: 1,
      compactionStallsPerSecond: 1,
    },
  }
}

const HOST_BASE_FAMILIES: HostedFamily[] = ['host.system', 'host.io']

function ids(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`)
}

// ---------------------------------------------------------------------------
// 1. 1-NIC VM
// ---------------------------------------------------------------------------

/**
 * A VM that also reported a hardware-health event this tick. Exists so the
 * `"event"` row shape is actually covered: v4 never set `double20` on event
 * rows and no fixture carried an event, so the row-count suite's
 * `double20 === intervalSeconds` assertion never ran against one.
 */
function vmWithEvent(): RepresentativeMachineFixture {
  return {
    name: 'vm-with-event',
    input: baseInput({
      networks: [nic('eth0')],
      events: [
        {
          eventId: 'evt-1',
          at: '2026-01-01T00:00:00.000Z',
          kind: 'oom_kill',
          severity: 'warning',
        },
      ],
    }),
    plan: plan('virtual'),
    slotMapping: emptySlotMapping({ normalNicSlots: ['eth0'] }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'oom_kill' as HostedFamily],
    expectedRowCount: 3,
  }
}

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
// 5. Web VM (Caddy ingress source + the shared hosting router)
//
// The canonical shared-hosting web host: a per-site Caddy reporting as a
// `managed.ingress` source, plus the one host-wide Traefik router reporting
// as `managed.router`. Both ride the same `managedIngressEnabled`
// entitlement, so a plan that buys traffic visibility buys both rows.
// ---------------------------------------------------------------------------

function webVm(): RepresentativeMachineFixture {
  return {
    name: 'web-vm',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      ingressSources: [ingressSource('caddy0')],
      router: routerSample(),
    }),
    plan: plan('virtual', { managedIngressEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'managed.ingress', 'managed.router'],
    expectedRowCount: 4,
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
      router: routerSample(),
    }),
    plan: plan('virtual', { gpuSlots: 1, managedIngressEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'gpu', 'managed.ingress', 'managed.router'],
    expectedRowCount: 5,
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
  // 10 board/CPU sensors plus the 3 entity-joined signals gpu0 contributes —
  // 13 fits one 19-wide `hardware.physical` page, so the row count is
  // unchanged and the +3-per-GPU growth is pinned by signal *identity* in
  // `representative-row-counts.test.ts`, not by a row total.
  const signalIds = [...ids(10, 'sig'), ...gpuSignalIds('gpu0')]
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
      hardwareSignalPageOrder: sorted(signalIds),
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'gpu', 'hardware.physical'],
    expectedRowCount: 4,
  }
}

// ---------------------------------------------------------------------------
// 11. 4-NIC host, all four monitored on a 4-slot plan (2 embedded + 2 paged
//     -> 1 network page). An unmonitored NIC never reaches the store at all
//     (`truncateSampleToCapabilityPlan`), so only monitored slots page.
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
// 13. 16-GPU host (ceil(16/3) = 6 pages)
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
    expectedFamilies: [...HOST_BASE_FAMILIES, ...new Array(6).fill('gpu')],
    expectedRowCount: 8,
  }
}

// ---------------------------------------------------------------------------
// 14. 24-block-device host (ceil(24/2) = 12 block pages), each drive also
//     contributing its entity-joined temperature signal (24 signals ->
//     ceil(24/19) = 2 `hardware.physical` pages). `physicalHardwareSignalSlots`
//     is raised past the 19 baseline deliberately: at the default this host
//     would be silently truncated to 19 signals, which is exactly the
//     regression the row-count suite has to catch rather than absorb.
// ---------------------------------------------------------------------------

function twentyFourBlockDevices(): RepresentativeMachineFixture {
  const deviceIds = ids(24, 'sd')
  const signalIds = deviceIds.map(blockSignalId)
  return {
    name: '24-block-devices',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      blockDevices: deviceIds.map((id, i) => blockDevice(id, i)),
      hardwareSignals: signalIds.map((id, i) => hardwareSignal(id, i)),
    }),
    plan: plan('physical', {
      detailedBlockDeviceSlots: 24,
      physicalHardwareSignalSlots: 24,
    }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      blockPageOrder: sorted(deviceIds),
      hardwareSignalPageOrder: sorted(signalIds),
    }),
    expectedFamilies: [
      ...HOST_BASE_FAMILIES,
      ...new Array(12).fill('block'),
      ...new Array(2).fill('hardware.physical'),
    ],
    expectedRowCount: 16,
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
// 16. Large-CPU/RAM host (merged `diagnostics` depth family)
//
// v6 needs no plan override here: the family is ungated, so the row is
// emitted purely because the collector produced `diagnostics`. Its two v5
// rows (`cpu.detail` + `memory.detail`) are one `host.diagnostics` row now,
// which is why this fixture is 3 rows rather than 4.
// ---------------------------------------------------------------------------

function largeCpuRam(): RepresentativeMachineFixture {
  return {
    name: 'large-cpu-ram',
    input: baseInput({
      networks: [nic('eth0'), nic('eth1', 2)],
      diagnostics: diagnostics(),
    }),
    plan: plan('virtual'),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
    }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'host.diagnostics'],
    expectedRowCount: 3,
  }
}

// ---------------------------------------------------------------------------
// 17. Managed-storage host (`managed.storage` + `managed.docker`)
//
// The shared-hosting box the storage panel is for: a hosting root, a backup
// root and a log directory on their own filesystems (so the `backup`/`logs`
// topology roles are actually exercised by the pinning order), plus Docker
// reporting its `/system/df` breakdown. `managed.storage` is ungated, so it
// rides purely on the daemon having produced it; `managed.docker` needs
// `managedDockerEnabled` — the fixture below turns it off to prove the key
// is dropped rather than emitted empty.
// ---------------------------------------------------------------------------

function managedStorageHost(): RepresentativeMachineFixture {
  const filesystemIds = ['fs-backup', 'fs-hosting', 'fs-logs']
  return {
    name: 'managed-storage-host',
    input: baseInput({
      networks: [nic('eth0')],
      filesystems: filesystemIds.map((id, i) => filesystem(id, i + 1)),
      storage: storageSample(),
      dockerUsage: dockerUsageSample(),
    }),
    plan: plan('virtual', { extraFilesystemSlots: 3, managedDockerEnabled: true }),
    slotMapping: emptySlotMapping({
      normalNicSlots: ['eth0'],
      // Role-pinned first (hosting, docker, backup, logs — this host has no
      // separate Docker filesystem), then the rest by id. Mirrors what
      // `computeSlotMapping` produces for a snapshot carrying those roles.
      filesystemPageOrder: ['fs-hosting', 'fs-backup', 'fs-logs'],
    }),
    // Three filesystems fit one 9-per-page `filesystem` row (2 fields wide).
    expectedFamilies: [
      ...HOST_BASE_FAMILIES,
      'filesystem',
      'managed.storage',
      'managed.docker',
    ],
    expectedRowCount: 5,
  }
}

// ---------------------------------------------------------------------------
// 18. Managed-storage host with the Docker breakdown gated off
//
// Same shape, `managedDockerEnabled: false`. `truncateSampleToCapabilityPlan`
// drops the `dockerUsage` key outright, so no `managed.docker` row is emitted
// and `managed.storage` — ungated — still is. The pair is what pins the flag's
// effect on row count.
// ---------------------------------------------------------------------------

function managedStorageHostDockerOff(): RepresentativeMachineFixture {
  return {
    name: 'managed-storage-host-docker-off',
    input: baseInput({
      networks: [nic('eth0')],
      storage: storageSample(),
      dockerUsage: dockerUsageSample(),
    }),
    plan: plan('virtual', { managedDockerEnabled: false }),
    slotMapping: emptySlotMapping({ normalNicSlots: ['eth0'] }),
    expectedFamilies: [...HOST_BASE_FAMILIES, 'managed.storage'],
    expectedRowCount: 3,
  }
}

/** All 19 representative-machine fixtures, in the order documented in the plan. */
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
    managedStorageHost(),
    managedStorageHostDockerOff(),
    vmWithEvent(),
  ]
}
