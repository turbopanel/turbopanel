import { assertEquals, assertNotEquals } from '@std/assert'
import {
  computeMetricsCapabilityPlanHash,
  type MetricsCapabilityPlanV4,
  metricsDeploymentKindForRuntime,
  parseMetricsCapabilityPlanOverride,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  platformDefaultMetricsCapabilityPlan,
  resolveMetricsCapabilityPlan,
  SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS,
  truncateSampleToCapabilityPlanV4,
} from './capability-plan.ts'
import type { MetricsSampleV4 } from './contract-v4.ts'
import { MAX_NIC_SLOTS, type SlotMapping } from '../../client/servers/topology-types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('resolveMetricsCapabilityPlan with no overrides returns the physical platform default', () => {
  const resolved = resolveMetricsCapabilityPlan('physical', undefined, undefined, 'hosted')
  assertEquals(resolved, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
})

test('resolveMetricsCapabilityPlan: org override wins over platform default', () => {
  const resolved = resolveMetricsCapabilityPlan('physical', { gpuSlots: 4 }, undefined, 'hosted')
  assertEquals(resolved.gpuSlots, 4)
  assertEquals(resolved.normalNicSlots, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.normalNicSlots)
})

test('resolveMetricsCapabilityPlan: server override wins over org override', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    { gpuSlots: 4 },
    { gpuSlots: 8 },
    'hosted'
  )
  assertEquals(resolved.gpuSlots, 8)
})

test('resolveMetricsCapabilityPlan: server override only touches fields it sets', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    { gpuSlots: 4, managedIngressEnabled: false },
    { gpuSlots: 8 },
    'hosted'
  )
  assertEquals(resolved.gpuSlots, 8)
  assertEquals(resolved.managedIngressEnabled, false)
})

test('resolveMetricsCapabilityPlan: virtual machine resolves physicalHardwareSignalSlots=0 with no overrides', () => {
  const resolved = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'hosted')
  assertEquals(resolved.physicalHardwareSignalSlots, 0)
})

test('resolveMetricsCapabilityPlan: physical machine resolves physicalHardwareSignalSlots=19 with no overrides', () => {
  const resolved = resolveMetricsCapabilityPlan('physical', undefined, undefined, 'hosted')
  assertEquals(resolved.physicalHardwareSignalSlots, 19)
})

test('resolveMetricsCapabilityPlan: virtual and physical machines otherwise share the same defaults', () => {
  const virtual = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'hosted')
  const physical = resolveMetricsCapabilityPlan('physical', undefined, undefined, 'hosted')
  assertEquals(
    { ...virtual, physicalHardwareSignalSlots: 0 },
    { ...physical, physicalHardwareSignalSlots: 0 }
  )
})

test('resolveMetricsCapabilityPlan: an explicit override still wins over the machine-class default', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'virtual',
    undefined,
    {
      physicalHardwareSignalSlots: 5,
    },
    'hosted'
  )
  assertEquals(resolved.physicalHardwareSignalSlots, 5)
})

test('platformDefaultMetricsCapabilityPlan matches PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN for physical machines', () => {
  assertEquals(
    platformDefaultMetricsCapabilityPlan('physical', 'hosted'),
    PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN
  )
})

test('platformDefaultMetricsCapabilityPlan: hosted servers get 2 NIC slots, self-hosted the MAX_NIC_SLOTS ceiling, nothing else differs', () => {
  const hosted = platformDefaultMetricsCapabilityPlan('virtual', 'hosted')
  const selfHosted = platformDefaultMetricsCapabilityPlan('virtual', 'self-hosted')
  assertEquals(hosted.normalNicSlots, 2)
  assertEquals(selfHosted.normalNicSlots, SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS)
  assertEquals(SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS, MAX_NIC_SLOTS)
  assertEquals({ ...hosted, normalNicSlots: 0 }, { ...selfHosted, normalNicSlots: 0 })
  assertEquals(metricsDeploymentKindForRuntime('workers'), 'hosted')
  assertEquals(metricsDeploymentKindForRuntime('deno'), 'self-hosted')
})

test('resolveMetricsCapabilityPlan: an org/server normalNicSlots override still wins over the deployment default', () => {
  assertEquals(
    resolveMetricsCapabilityPlan('virtual', { normalNicSlots: 4 }, undefined, 'self-hosted')
      .normalNicSlots,
    4
  )
  assertEquals(
    resolveMetricsCapabilityPlan('virtual', undefined, { normalNicSlots: 1 }, 'hosted')
      .normalNicSlots,
    1
  )
})

test('parseMetricsCapabilityPlanOverride clamps normalNicSlots to MAX_NIC_SLOTS', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 99 }), {
    normalNicSlots: MAX_NIC_SLOTS,
  })
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 3 }), { normalNicSlots: 3 })
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseMetricsCapabilityPlanOverride returns empty object for non-records', () => {
  assertEquals(parseMetricsCapabilityPlanOverride(null), {})
  assertEquals(parseMetricsCapabilityPlanOverride([]), {})
  assertEquals(parseMetricsCapabilityPlanOverride('nope'), {})
})

test('parseMetricsCapabilityPlanOverride reads every field type', () => {
  const override = parseMetricsCapabilityPlanOverride({
    baselineIntervalSeconds: 30,
    liveMinIntervalSeconds: 5,
    normalNicSlots: 3,
    turboFabricEnabled: false,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 1,
    gpuSlots: 2,
    gpuInterconnectEnabled: true,
    physicalHardwareSignalSlots: 24,
    cpuDetailEnabled: true,
    cpuLiveCoreSlots: 8,
    memoryDetailEnabled: true,
    numaNodeSlots: 2,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
  assertEquals(override, {
    baselineIntervalSeconds: 30,
    liveMinIntervalSeconds: 5,
    normalNicSlots: 3,
    turboFabricEnabled: false,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 1,
    gpuSlots: 2,
    gpuInterconnectEnabled: true,
    physicalHardwareSignalSlots: 24,
    cpuDetailEnabled: true,
    cpuLiveCoreSlots: 8,
    memoryDetailEnabled: true,
    numaNodeSlots: 2,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
})

test('parseMetricsCapabilityPlanOverride rejects invalid types silently', () => {
  const override = parseMetricsCapabilityPlanOverride({
    gpuSlots: '2',
    turboFabricEnabled: 'yes',
    numaNodeSlots: null,
  })
  assertEquals(override, {})
})

test('parseMetricsCapabilityPlanOverride rejects negative and non-integer numbers', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ gpuSlots: -1 }).gpuSlots, undefined)
  assertEquals(parseMetricsCapabilityPlanOverride({ gpuSlots: 1.5 }).gpuSlots, undefined)
  assertEquals(
    parseMetricsCapabilityPlanOverride({ baselineIntervalSeconds: 0 }).baselineIntervalSeconds,
    undefined
  )
  assertEquals(
    parseMetricsCapabilityPlanOverride({ baselineIntervalSeconds: -60 }).baselineIntervalSeconds,
    undefined
  )
})

test('parseMetricsCapabilityPlanOverride silently omits unknown keys', () => {
  const override = parseMetricsCapabilityPlanOverride({
    gpuSlots: 2,
    pricingTier: 'enterprise',
  })
  assertEquals(override, { gpuSlots: 2 })
  assertEquals('pricingTier' in override, false)
})

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('computeMetricsCapabilityPlanHash is stable for an identical plan', async () => {
  const a = await computeMetricsCapabilityPlanHash(PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
  const b = await computeMetricsCapabilityPlanHash({
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  })
  assertEquals(a, b)
})

test('computeMetricsCapabilityPlanHash changes when one field changes', async () => {
  const base = await computeMetricsCapabilityPlanHash(PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
  const changed = await computeMetricsCapabilityPlanHash({
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.gpuSlots + 1,
  })
  assertNotEquals(base, changed)
})

// ---------------------------------------------------------------------------
// Truncation matrix
// ---------------------------------------------------------------------------

function emptySample(): MetricsSampleV4 {
  return {
    type: 'metrics',
    metadata: {
      version: 4,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 0,
      collectionMode: 'baseline',
      topologyGeneration: 0,
      bootGeneration: 0,
    },
    host: {
      cpu: {
        busyPercent: null,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        maxCoreBusyPercent: null,
        procsRunning: null,
        procsBlocked: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        availableBytes: null,
        swapUsedBytes: null,
        pressureSomePercent: null,
        pressureFullPercent: null,
        swapInBytesPerSecond: null,
        swapOutBytesPerSecond: null,
        majorPageFaultsPerSecond: null,
      },
      storage: {
        ioPressureSomePercent: null,
        ioPressureFullPercent: null,
        diskReadBytesPerSecond: null,
        diskWriteBytesPerSecond: null,
        diskReadLatencyMs: null,
        diskWriteLatencyMs: null,
        maxBlockDeviceUtilPercent: null,
        rootFilesystemAvailableBytes: null,
        rootFilesystemFreeInodes: null,
      },
      network: { tcpRetransmitPercent: null, softnetDropsPerSecond: null },
    },
    networks: [],
    filesystems: [],
    blockDevices: [],
    gpus: [],
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: [],
  }
}

function makeGpu(gpuId: string) {
  return {
    gpuId,
    utilizationPercent: null,
    memoryUsedBytes: null,
    memoryActivityPercent: null,
    temperatureCelsius: null,
    memoryTemperatureCelsius: null,
    powerWatts: null,
    pcieReceiveBytesPerSecond: null,
    pcieTransmitBytesPerSecond: null,
    throttlePercent: null,
  }
}

function makeIngressSource(sourceId: string) {
  return {
    sourceId,
    sourceKind: sourceId,
    requests: null,
    responses2xx: null,
    responses3xx: null,
    responses4xx: null,
    responses5xx: null,
    requestErrors: null,
    requestBytes: null,
    responseBytes: null,
    requestDurationSecondsAvg: null,
    requestsUnder100ms: null,
    requestsUnder500ms: null,
    requestsUnder1s: null,
    requestsUnder5s: null,
    requestsInFlight: null,
    upstreamsHealthy: null,
    upstreamsTotal: null,
    retries: null,
  }
}

test('truncateSampleToCapabilityPlanV4: 0 discovered GPUs stays 0 regardless of gpuSlots', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 1,
  }
  const sample = emptySample()
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.gpus, [])
})

test('truncateSampleToCapabilityPlanV4: 2 discovered GPUs with gpuSlots=1 keeps the first only', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 1,
  }
  const sample = emptySample()
  sample.gpus = [makeGpu('gpu-0'), makeGpu('gpu-1')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.gpus.map((g) => g.gpuId),
    ['gpu-0']
  )
})

test('truncateSampleToCapabilityPlanV4: 2 discovered GPUs with gpuSlots=2 keeps both', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 2,
  }
  const sample = emptySample()
  sample.gpus = [makeGpu('gpu-0'), makeGpu('gpu-1')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.gpus.map((g) => g.gpuId),
    ['gpu-0', 'gpu-1']
  )
})

test('truncateSampleToCapabilityPlanV4: managedIngressEnabled=false drops all ingress sources regardless of count', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
  }
  const sample = emptySample()
  sample.ingressSources = [makeIngressSource('caddy'), makeIngressSource('nginx')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.ingressSources, [])
})

test('truncateSampleToCapabilityPlanV4: managedIngressEnabled=true keeps ingress sources', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: true,
  }
  const sample = emptySample()
  sample.ingressSources = [makeIngressSource('caddy')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.ingressSources.map((s) => s.sourceId),
    ['caddy']
  )
})

function makeCpuDetail() {
  return {
    hotspots: [{ coreId: 'cpu0', busyPercent: 80, iowaitPercent: 1, stealPercent: 0 }],
    averageFrequencyMHz: null,
    minimumFrequencyMHz: null,
    maximumFrequencyMHz: null,
    contextSwitchesPerSecond: null,
    interruptsPerSecond: null,
    forksPerSecond: null,
    cpuIrqPercent: null,
  }
}

function makeMemoryDetail() {
  return {
    memoryFreeBytes: null,
    cachedBytes: null,
    anonPagesBytes: null,
    slabReclaimableBytes: null,
    slabUnreclaimableBytes: null,
    dirtyBytes: null,
    writebackBytes: null,
    shmemBytes: null,
    pageTablesBytes: null,
    kernelStackBytes: null,
    committedAsBytes: null,
    commitLimitBytes: null,
    activeAnonBytes: null,
    inactiveAnonBytes: null,
    activeFileBytes: null,
    inactiveFileBytes: null,
    pageScanDirectPerSecond: null,
    pageScanKswapdPerSecond: null,
    compactionStallsPerSecond: null,
  }
}

function makeCpuCoreLive(coreId: string) {
  return { coreId, busyPercent: 50, iowaitPercent: 0, stealPercent: 0 }
}

test('truncateSampleToCapabilityPlanV4: disabled detail flags clear cpuDetail/memoryDetail', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    cpuDetailEnabled: false,
    memoryDetailEnabled: false,
  }
  const sample = emptySample()
  sample.cpuDetail = makeCpuDetail()
  sample.memoryDetail = makeMemoryDetail()
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.cpuDetail, undefined)
  assertEquals(truncated.memoryDetail, undefined)
})

test('truncateSampleToCapabilityPlanV4: enabled detail flags keep cpuDetail/memoryDetail', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    cpuDetailEnabled: true,
    memoryDetailEnabled: true,
  }
  const sample = emptySample()
  const cpuDetail = makeCpuDetail()
  sample.cpuDetail = cpuDetail
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.cpuDetail, cpuDetail)
})

// ---------------------------------------------------------------------------
// cpuCoreLive: live-only + slot-count gating
// ---------------------------------------------------------------------------

test('truncateSampleToCapabilityPlanV4: baseline sample with cpuCoreLive populated is stripped', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    cpuLiveCoreSlots: 8,
  }
  const sample = emptySample()
  sample.metadata.collectionMode = 'baseline'
  sample.cpuCoreLive = [makeCpuCoreLive('cpu0'), makeCpuCoreLive('cpu1')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.cpuCoreLive, undefined)
})

test('truncateSampleToCapabilityPlanV4: live sample with cpuLiveCoreSlots=0 is stripped', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    cpuLiveCoreSlots: 0,
  }
  const sample = emptySample()
  sample.metadata.collectionMode = 'live'
  sample.cpuCoreLive = [makeCpuCoreLive('cpu0'), makeCpuCoreLive('cpu1')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.cpuCoreLive?.length ?? 0, 0)
})

test('truncateSampleToCapabilityPlanV4: live sample within slot budget passes through, over budget truncates', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    cpuLiveCoreSlots: 2,
  }
  const sample = emptySample()
  sample.metadata.collectionMode = 'live'
  sample.cpuCoreLive = [makeCpuCoreLive('cpu0'), makeCpuCoreLive('cpu1'), makeCpuCoreLive('cpu2')]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.cpuCoreLive?.map((c) => c.coreId),
    ['cpu0', 'cpu1']
  )
})

test('truncateSampleToCapabilityPlanV4: truncates blockDevices/filesystems/hardwareSignals/numaNodes to slot counts', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    detailedBlockDeviceSlots: 1,
    extraFilesystemSlots: 1,
    physicalHardwareSignalSlots: 1,
    numaNodeSlots: 1,
  }
  const sample = emptySample()
  sample.blockDevices = [
    {
      deviceId: 'sda',
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      readOpsPerSecond: null,
      writeOpsPerSecond: null,
      readLatencyMs: null,
      writeLatencyMs: null,
      utilizationPercent: null,
      temperatureCelsius: null,
      queueDepth: null,
    },
    {
      deviceId: 'sdb',
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
      readOpsPerSecond: null,
      writeOpsPerSecond: null,
      readLatencyMs: null,
      writeLatencyMs: null,
      utilizationPercent: null,
      temperatureCelsius: null,
      queueDepth: null,
    },
  ]
  sample.filesystems = [
    { filesystemId: 'fs-a', availableBytes: null, freeInodes: null },
    { filesystemId: 'fs-b', availableBytes: null, freeInodes: null },
  ]
  sample.hardwareSignals = [
    { signalId: 'fan-1', kind: 'fan', value: null },
    { signalId: 'fan-2', kind: 'fan', value: null },
  ]
  sample.numaNodes = [
    {
      nodeId: 'node-0',
      freeBytes: null,
      totalBytes: null,
      localAllocationsPerSecond: null,
      foreignAllocationsPerSecond: null,
    },
    {
      nodeId: 'node-1',
      freeBytes: null,
      totalBytes: null,
      localAllocationsPerSecond: null,
      foreignAllocationsPerSecond: null,
    },
  ]

  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.blockDevices.map((d) => d.deviceId),
    ['sda']
  )
  assertEquals(
    truncated.filesystems.map((f) => f.filesystemId),
    ['fs-a']
  )
  assertEquals(
    truncated.hardwareSignals.map((s) => s.signalId),
    ['fan-1']
  )
  assertEquals(
    truncated.numaNodes?.map((n) => n.nodeId),
    ['node-0']
  )
})

test('truncateSampleToCapabilityPlanV4: a root-tagged filesystem entry is dropped before extraFilesystemSlots applies, never spending a slot on /', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    extraFilesystemSlots: 1,
  }
  const sample = emptySample()
  sample.filesystems = [
    { filesystemId: 'fs-root', availableBytes: null, freeInodes: null },
    { filesystemId: 'fs-data', availableBytes: null, freeInodes: null },
  ]
  const slotMapping: SlotMapping = {
    normalNicSlots: [],
    fabricDeviceIds: [],
    rootFilesystemId: 'fs-root',
    gpuPageOrder: [],
    blockPageOrder: [],
    filesystemPageOrder: [],
    hardwareSignalPageOrder: [],
  }

  // Without slotMapping there is nothing to identify as root, so the naive
  // count-based slice still applies (matches an unmappable/pre-topology
  // sample's behavior).
  const withoutMapping = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    withoutMapping.filesystems.map((f) => f.filesystemId),
    ['fs-root']
  )

  const withMapping = truncateSampleToCapabilityPlanV4(sample, plan, slotMapping)
  assertEquals(
    withMapping.filesystems.map((f) => f.filesystemId),
    ['fs-data']
  )
})

test('truncateSampleToCapabilityPlanV4: databaseProxyMetricsEnabled and hardwareHealthEventsEnabled gate their arrays', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  }
  const sample = emptySample()
  sample.databaseProxies = [
    {
      sourceId: 'proxysql',
      sourceKind: 'proxysql',
      queries: null,
      slowQueries: null,
      connectionErrors: null,
      clientConnections: null,
      backendConnections: null,
      backendsUp: null,
    },
  ]
  sample.events = [
    {
      eventId: 'evt-1',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'fan_fault',
      severity: 'critical',
    },
  ]
  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(truncated.databaseProxies, [])
  assertEquals(truncated.events, [])
})

test('truncateSampleToCapabilityPlanV4: hardwareHealthEventsEnabled=false drops only hardware-health event kinds', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    hardwareHealthEventsEnabled: false,
  }
  const sample = emptySample()
  sample.events = [
    {
      eventId: 'evt-hw',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'fan_fault',
      severity: 'critical',
    },
    {
      eventId: 'evt-oom',
      at: '2026-01-01T00:00:01.000Z',
      kind: 'oom_kill',
      severity: 'critical',
    },
    {
      eventId: 'evt-fabric',
      at: '2026-01-01T00:00:02.000Z',
      kind: 'fabric_unavailable',
      severity: 'warning',
    },
    {
      eventId: 'evt-clock',
      at: '2026-01-01T00:00:03.000Z',
      kind: 'clock_sync_lost',
      severity: 'warning',
    },
    {
      eventId: 'evt-topology',
      at: '2026-01-01T00:00:04.000Z',
      kind: 'topology_generation_changed',
      severity: 'info',
    },
    {
      eventId: 'evt-boot',
      at: '2026-01-01T00:00:05.000Z',
      kind: 'boot_generation_changed',
      severity: 'info',
    },
    {
      eventId: 'evt-remount',
      at: '2026-01-01T00:00:06.000Z',
      kind: 'fs_remount',
      severity: 'info',
    },
  ]

  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.events.map((event) => event.eventId),
    ['evt-oom', 'evt-fabric', 'evt-clock', 'evt-topology', 'evt-boot', 'evt-remount']
  )
})

test('truncateSampleToCapabilityPlanV4: hardwareHealthEventsEnabled=true keeps every event kind', () => {
  const plan: MetricsCapabilityPlanV4 = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    hardwareHealthEventsEnabled: true,
  }
  const sample = emptySample()
  sample.events = [
    {
      eventId: 'evt-hw',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'fan_fault',
      severity: 'critical',
    },
    {
      eventId: 'evt-oom',
      at: '2026-01-01T00:00:01.000Z',
      kind: 'oom_kill',
      severity: 'critical',
    },
  ]

  const truncated = truncateSampleToCapabilityPlanV4(sample, plan)
  assertEquals(
    truncated.events.map((event) => event.eventId),
    ['evt-hw', 'evt-oom']
  )
})

// ---------------------------------------------------------------------------
// networks truncation
// ---------------------------------------------------------------------------

function makeNetwork(deviceId: string): MetricsSampleV4['networks'][number] {
  return {
    deviceId,
    receiveBytesPerSecond: 1,
    transmitBytesPerSecond: 1,
    receiveErrorsPerSecond: 0,
    transmitErrorsPerSecond: 0,
    receiveDropsPerSecond: 0,
    transmitDropsPerSecond: 0,
  }
}

function emptySlotMappingForNetworks(overrides: Partial<SlotMapping> = {}): SlotMapping {
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

test('truncateSampleToCapabilityPlanV4: networks keeps the slot-mapped NICs within normalNicSlots (slot order) plus fabric, and drops everything else', () => {
  const sample: MetricsSampleV4 = {
    ...emptySample(),
    // Deliberately out of slot order, with an unmonitored device mixed in.
    networks: ['veth9', 'eth2', 'tp0', 'eth0', 'eth1'].map(makeNetwork),
  }
  const plan = resolveMetricsCapabilityPlan('virtual', undefined, { normalNicSlots: 2 }, 'hosted')
  const mapping = emptySlotMappingForNetworks({
    normalNicSlots: ['eth0', 'eth1', 'eth2'],
    fabricDeviceIds: ['tp0'],
  })
  const kept = truncateSampleToCapabilityPlanV4(sample, plan, mapping).networks.map(
    (n) => n.deviceId
  )
  assertEquals(kept, ['eth0', 'eth1', 'tp0'])

  const selfHosted = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'self-hosted')
  assertEquals(
    truncateSampleToCapabilityPlanV4(sample, selfHosted, mapping).networks.map((n) => n.deviceId),
    ['eth0', 'eth1', 'eth2', 'tp0']
  )

  const noFabric = resolveMetricsCapabilityPlan(
    'virtual',
    undefined,
    { turboFabricEnabled: false },
    'self-hosted'
  )
  assertEquals(
    truncateSampleToCapabilityPlanV4(sample, noFabric, mapping).networks.map((n) => n.deviceId),
    ['eth0', 'eth1', 'eth2']
  )
})

test('truncateSampleToCapabilityPlanV4: a slot-mapped NIC absent from the sample is simply missing — no other device takes its slot', () => {
  const sample: MetricsSampleV4 = {
    ...emptySample(),
    networks: ['eth1', 'eth5'].map(makeNetwork),
  }
  const plan = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'hosted')
  const mapping = emptySlotMappingForNetworks({ normalNicSlots: ['eth0', 'eth1'] })
  assertEquals(
    truncateSampleToCapabilityPlanV4(sample, plan, mapping).networks.map((n) => n.deviceId),
    ['eth1']
  )
})

test('truncateSampleToCapabilityPlanV4: without a slot mapping, networks fall back to the first normalNicSlots entries positionally', () => {
  const sample: MetricsSampleV4 = {
    ...emptySample(),
    networks: ['eth0', 'eth1', 'eth2', 'tp0'].map(makeNetwork),
  }
  const hosted = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'hosted')
  assertEquals(
    truncateSampleToCapabilityPlanV4(sample, hosted).networks.map((n) => n.deviceId),
    ['eth0', 'eth1']
  )
  const selfHosted = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'self-hosted')
  assertEquals(selfHosted.normalNicSlots, MAX_NIC_SLOTS)
  assertEquals(
    truncateSampleToCapabilityPlanV4(sample, selfHosted).networks.map((n) => n.deviceId),
    ['eth0', 'eth1', 'eth2', 'tp0']
  )
})
