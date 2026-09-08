import { assertEquals, assertNotEquals } from '@std/assert'
import {
  computeMetricsCapabilityPlanHash,
  inferServerMachineClass,
  isServerMachineClass,
  isUnmarkedLiveCadenceInterval,
  METRICS_BASELINE_INTERVAL_SECONDS,
  type MetricsCapabilityPlan,
  metricsCapabilityPlanFromTierEntitlements,
  type MetricsCapabilityTierEntitlements,
  metricsDeploymentKindForRuntime,
  parseMetricsCapabilityPlanOverride,
  PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  platformDefaultMetricsCapabilityPlan,
  resolveMetricsCapabilityPlan,
  resolveServerMachineClass,
  resolveTierMetricsCapabilityPlan,
  SELF_HOSTED_DEFAULT_NORMAL_NIC_SLOTS,
  truncateSampleToCapabilityPlan,
} from './capability-plan.ts'
import type { MetricsSample } from './contract.ts'
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
  assertEquals(
    { ...hosted, normalNicSlots: 0 },
    {
      ...selfHosted,
      normalNicSlots: 0,
    }
  )
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

const ENTRY_TIER_ENTITLEMENTS: MetricsCapabilityTierEntitlements = {
  nicSlots: 2,
  driveSlots: 2,
  gpuSlots: 1,
  filesystemSlots: 4,
  isEntryTier: true,
}

const STANDARD_TIER_ENTITLEMENTS: MetricsCapabilityTierEntitlements = {
  nicSlots: 5,
  driveSlots: 4,
  gpuSlots: 2,
  filesystemSlots: 3,
  isEntryTier: false,
}

test('metricsCapabilityPlanFromTierEntitlements overrides the platform default slot counts', () => {
  const plan = metricsCapabilityPlanFromTierEntitlements(
    STANDARD_TIER_ENTITLEMENTS,
    'physical',
    'hosted'
  )
  assertEquals(plan.normalNicSlots, 5)
  assertEquals(plan.detailedBlockDeviceSlots, 4)
  assertEquals(plan.gpuSlots, 2)
  assertEquals(plan.extraFilesystemSlots, 3)
  assertEquals(plan.managedDockerEnabled, true)
  assertEquals(
    plan.physicalHardwareSignalSlots,
    PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN.physicalHardwareSignalSlots
  )
  assertEquals(
    resolveTierMetricsCapabilityPlan(STANDARD_TIER_ENTITLEMENTS, 'physical', 'hosted'),
    plan
  )
})

test('metricsCapabilityPlanFromTierEntitlements: entry-tier carve-outs apply only at the entry tier', () => {
  const entry = metricsCapabilityPlanFromTierEntitlements(
    ENTRY_TIER_ENTITLEMENTS,
    'physical',
    'hosted'
  )
  assertEquals(entry.extraFilesystemSlots, 0)
  assertEquals(entry.physicalHardwareSignalSlots, 11)
  assertEquals(entry.managedDockerEnabled, false)

  const standard = metricsCapabilityPlanFromTierEntitlements(
    STANDARD_TIER_ENTITLEMENTS,
    'physical',
    'hosted'
  )
  assertEquals(standard.extraFilesystemSlots, 3)
  assertEquals(standard.physicalHardwareSignalSlots, 19)
  assertEquals(standard.managedDockerEnabled, true)
})

test('metricsCapabilityPlanFromTierEntitlements: virtual machines still get zero hardware-signal slots on the entry tier', () => {
  const plan = metricsCapabilityPlanFromTierEntitlements(
    ENTRY_TIER_ENTITLEMENTS,
    'virtual',
    'hosted'
  )
  assertEquals(plan.physicalHardwareSignalSlots, 0)
  assertEquals(plan.managedDockerEnabled, false)
})

test('resolveMetricsCapabilityPlan: a tier-derived base replaces the platform default', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    undefined,
    undefined,
    'hosted',
    STANDARD_TIER_ENTITLEMENTS
  )
  assertEquals(resolved.normalNicSlots, 5)
  assertEquals(resolved.gpuSlots, 2)
})

test('resolveMetricsCapabilityPlan: org/server overrides still win over a tier-derived base', () => {
  const resolved = resolveMetricsCapabilityPlan(
    'physical',
    { gpuSlots: 8 },
    { normalNicSlots: 3 },
    'hosted',
    STANDARD_TIER_ENTITLEMENTS
  )
  assertEquals(resolved.gpuSlots, 8)
  assertEquals(resolved.normalNicSlots, 3)
  assertEquals(resolved.detailedBlockDeviceSlots, 4)
})

test('resolveMetricsCapabilityPlan: absent tier preserves the platform-default path', () => {
  const withUndefined = resolveMetricsCapabilityPlan('physical', undefined, undefined, 'hosted')
  const withExplicitUndefined = resolveMetricsCapabilityPlan(
    'physical',
    undefined,
    undefined,
    'hosted',
    undefined
  )
  assertEquals(withUndefined, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
  assertEquals(withExplicitUndefined, PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN)
})

test('computeMetricsCapabilityPlanHash changes when tier entitlements change the resolved plan', async () => {
  const entryHash = await computeMetricsCapabilityPlanHash(
    metricsCapabilityPlanFromTierEntitlements(ENTRY_TIER_ENTITLEMENTS, 'physical', 'hosted')
  )
  const standardHash = await computeMetricsCapabilityPlanHash(
    metricsCapabilityPlanFromTierEntitlements(STANDARD_TIER_ENTITLEMENTS, 'physical', 'hosted')
  )
  assertNotEquals(entryHash, standardHash)
})

test('parseMetricsCapabilityPlanOverride clamps normalNicSlots to MAX_NIC_SLOTS', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 99 }), {
    normalNicSlots: MAX_NIC_SLOTS,
  })
  assertEquals(parseMetricsCapabilityPlanOverride({ normalNicSlots: 3 }), {
    normalNicSlots: 3,
  })
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
    liveMinIntervalSeconds: 5,
    normalNicSlots: 3,
    turboFabricEnabled: false,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 1,
    gpuSlots: 2,
    gpuInterconnectEnabled: true,
    physicalHardwareSignalSlots: 24,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
  assertEquals(override, {
    liveMinIntervalSeconds: 5,
    normalNicSlots: 3,
    turboFabricEnabled: false,
    extraFilesystemSlots: 2,
    detailedBlockDeviceSlots: 1,
    gpuSlots: 2,
    gpuInterconnectEnabled: true,
    physicalHardwareSignalSlots: 24,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
})

test('parseMetricsCapabilityPlanOverride rejects invalid types silently', () => {
  const override = parseMetricsCapabilityPlanOverride({
    gpuSlots: '2',
    turboFabricEnabled: 'yes',
    extraFilesystemSlots: null,
  })
  assertEquals(override, {})
})

test('parseMetricsCapabilityPlanOverride rejects negative and non-integer numbers', () => {
  assertEquals(parseMetricsCapabilityPlanOverride({ gpuSlots: -1 }).gpuSlots, undefined)
  assertEquals(parseMetricsCapabilityPlanOverride({ gpuSlots: 1.5 }).gpuSlots, undefined)
  assertEquals(
    parseMetricsCapabilityPlanOverride({ liveMinIntervalSeconds: 0 }).liveMinIntervalSeconds,
    undefined
  )
  assertEquals(
    parseMetricsCapabilityPlanOverride({ liveMinIntervalSeconds: -10 }).liveMinIntervalSeconds,
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

function emptySample(): MetricsSample {
  return {
    type: 'metrics',
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 0,
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
        saturatedCoreCount: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
      },
      kernel: { fileHandlesUsedPercent: null, conntrackUsedPercent: null },
      memory: {
        usedBytes: null,
        cachedFilesBytes: null,
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
        diskLatencyMs: null,
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
    requestDurationSecondsSum: null,
    bucket10ms: null,
    bucket50ms: null,
    bucket100ms: null,
    bucket500ms: null,
    bucket1s: null,
    bucket5s: null,
    requestsInFlight: null,
    upstreamsHealthy: null,
    upstreamsTotal: null,
    retries: null,
  }
}

test('truncateSampleToCapabilityPlan: 0 discovered GPUs stays 0 regardless of gpuSlots', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 1,
  }
  const sample = emptySample()
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(truncated.gpus, [])
})

test('truncateSampleToCapabilityPlan: 2 discovered GPUs with gpuSlots=1 keeps the first only', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 1,
  }
  const sample = emptySample()
  sample.gpus = [makeGpu('gpu-0'), makeGpu('gpu-1')]
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(
    truncated.gpus.map((g) => g.gpuId),
    ['gpu-0']
  )
})

test('truncateSampleToCapabilityPlan: 2 discovered GPUs with gpuSlots=2 keeps both', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    gpuSlots: 2,
  }
  const sample = emptySample()
  sample.gpus = [makeGpu('gpu-0'), makeGpu('gpu-1')]
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(
    truncated.gpus.map((g) => g.gpuId),
    ['gpu-0', 'gpu-1']
  )
})

test('truncateSampleToCapabilityPlan: managedIngressEnabled=false drops all ingress sources regardless of count', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
  }
  const sample = emptySample()
  sample.ingressSources = [makeIngressSource('caddy'), makeIngressSource('nginx')]
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(truncated.ingressSources, [])
})

test('truncateSampleToCapabilityPlan: managedIngressEnabled=true keeps ingress sources', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: true,
  }
  const sample = emptySample()
  sample.ingressSources = [makeIngressSource('caddy')]
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(
    truncated.ingressSources.map((s) => s.sourceId),
    ['caddy']
  )
})

function makeRouter() {
  return {
    backendsUp: 1,
    backendsTotal: 2,
    servicesTotal: 3,
    routersTotal: 4,
    retries: 0,
    backendErrors5xx: 0,
    backendLatencyMsAvg: 5,
    backendRequests: 10,
    httpOpenConnections: 2,
    configReloads: 1,
    configLastReloadAgeSeconds: 30,
    tlsCertSoonestExpiryDays: 60,
  }
}

test('truncateSampleToCapabilityPlan: managedIngressEnabled gates the router the same way it gates ingress sources', () => {
  const enabledSample = emptySample()
  enabledSample.router = makeRouter()
  const kept = truncateSampleToCapabilityPlan(enabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: true,
  })
  assertEquals(kept.router, makeRouter())

  const disabledSample = emptySample()
  disabledSample.router = makeRouter()
  const dropped = truncateSampleToCapabilityPlan(disabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
  })
  // Dropped by omitting the key, never by assigning `undefined` — a
  // present-but-undefined property is a different shape than an absent one.
  assertEquals(dropped.router, undefined)
  assertEquals(Object.hasOwn(dropped, 'router'), false)
})

function makeStorage() {
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

function makeDockerUsage() {
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

test('truncateSampleToCapabilityPlan: managedDockerEnabled gates dockerUsage by omitting the key', () => {
  const enabledSample = emptySample()
  enabledSample.dockerUsage = makeDockerUsage()
  const kept = truncateSampleToCapabilityPlan(enabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedDockerEnabled: true,
  })
  assertEquals(kept.dockerUsage, makeDockerUsage())

  const disabledSample = emptySample()
  disabledSample.dockerUsage = makeDockerUsage()
  const dropped = truncateSampleToCapabilityPlan(disabledSample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedDockerEnabled: false,
  })
  assertEquals(dropped.dockerUsage, undefined)
  assertEquals(Object.hasOwn(dropped, 'dockerUsage'), false)
})

test('truncateSampleToCapabilityPlan: storage is ungated and survives every flag being off', () => {
  const sample = emptySample()
  sample.storage = makeStorage()
  const truncated = truncateSampleToCapabilityPlan(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
    databaseProxyMetricsEnabled: false,
    managedDockerEnabled: false,
    hardwareHealthEventsEnabled: false,
  })
  assertEquals(truncated.storage, makeStorage())
})

test('truncateSampleToCapabilityPlan: the router and dockerUsage gates compose independently', () => {
  const sample = emptySample()
  sample.router = makeRouter()
  sample.dockerUsage = makeDockerUsage()
  sample.storage = makeStorage()
  const truncated = truncateSampleToCapabilityPlan(sample, {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    managedIngressEnabled: false,
    managedDockerEnabled: false,
  })
  assertEquals(Object.hasOwn(truncated, 'router'), false)
  assertEquals(Object.hasOwn(truncated, 'dockerUsage'), false)
  assertEquals(truncated.storage, makeStorage())
})

function makeDiagnostics() {
  return {
    cpu: {
      averageFrequencyMHz: null,
      minimumFrequencyMHz: null,
      maximumFrequencyMHz: null,
      contextSwitchesPerSecond: null,
      interruptsPerSecond: null,
      forksPerSecond: null,
      cpuIrqPercent: null,
    },
    memory: {
      memoryFreeBytes: null,
      cachedBytes: null,
      anonPagesBytes: null,
      slabReclaimableBytes: null,
      slabUnreclaimableBytes: null,
      dirtyBytes: null,
      writebackBytes: null,
      shmemBytes: null,
      committedAsBytes: null,
      pageScanDirectPerSecond: null,
      pageScanKswapdPerSecond: null,
      compactionStallsPerSecond: null,
    },
  }
}

test('truncateSampleToCapabilityPlan: diagnostics is ungated and always passes through untouched', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
  }
  const sample = emptySample()
  const diagnostics = makeDiagnostics()
  sample.diagnostics = diagnostics
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(truncated.diagnostics, diagnostics)
})

test('truncateSampleToCapabilityPlan: truncates blockDevices/filesystems/hardwareSignals to slot counts', () => {
  const plan: MetricsCapabilityPlan = {
    ...PLATFORM_DEFAULT_METRICS_CAPABILITY_PLAN,
    detailedBlockDeviceSlots: 1,
    extraFilesystemSlots: 1,
    physicalHardwareSignalSlots: 1,
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

  const truncated = truncateSampleToCapabilityPlan(sample, plan)
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
})

test('truncateSampleToCapabilityPlan: a root-tagged filesystem entry is dropped before extraFilesystemSlots applies, never spending a slot on /', () => {
  const plan: MetricsCapabilityPlan = {
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
  const withoutMapping = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(
    withoutMapping.filesystems.map((f) => f.filesystemId),
    ['fs-root']
  )

  const withMapping = truncateSampleToCapabilityPlan(sample, plan, slotMapping)
  assertEquals(
    withMapping.filesystems.map((f) => f.filesystemId),
    ['fs-data']
  )
})

test('truncateSampleToCapabilityPlan: databaseProxyMetricsEnabled and hardwareHealthEventsEnabled gate their arrays', () => {
  const plan: MetricsCapabilityPlan = {
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
      queryLatencyMsAvg: null,
      backendLatencyMsAvg: null,
      activeTransactions: null,
      clientConnections: null,
      clientConnectionsCreated: null,
      clientConnectionsAborted: null,
      connectionsRejectedMaxConns: null,
      backendConnections: null,
      backendConnectionsCreated: null,
      backendConnectionsAborted: null,
      connectionErrors: null,
      backendsUp: null,
      backendsTotal: null,
      bytesFromBackends: null,
      bytesToBackends: null,
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
  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(truncated.databaseProxies, [])
  assertEquals(truncated.events, [])
})

test('truncateSampleToCapabilityPlan: hardwareHealthEventsEnabled=false drops only hardware-health event kinds', () => {
  const plan: MetricsCapabilityPlan = {
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

  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(
    truncated.events.map((event) => event.eventId),
    ['evt-oom', 'evt-fabric', 'evt-clock', 'evt-topology', 'evt-boot', 'evt-remount']
  )
})

test('truncateSampleToCapabilityPlan: hardwareHealthEventsEnabled=true keeps every event kind', () => {
  const plan: MetricsCapabilityPlan = {
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

  const truncated = truncateSampleToCapabilityPlan(sample, plan)
  assertEquals(
    truncated.events.map((event) => event.eventId),
    ['evt-hw', 'evt-oom']
  )
})

// ---------------------------------------------------------------------------
// networks truncation
// ---------------------------------------------------------------------------

function makeNetwork(deviceId: string): MetricsSample['networks'][number] {
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

test('truncateSampleToCapabilityPlan: networks keeps the slot-mapped NICs within normalNicSlots (slot order) plus fabric, and drops everything else', () => {
  const sample: MetricsSample = {
    ...emptySample(),
    // Deliberately out of slot order, with an unmonitored device mixed in.
    networks: ['veth9', 'eth2', 'tp0', 'eth0', 'eth1'].map(makeNetwork),
  }
  const plan = resolveMetricsCapabilityPlan(
    'virtual',
    undefined,
    {
      normalNicSlots: 2,
    },
    'hosted'
  )
  const mapping = emptySlotMappingForNetworks({
    normalNicSlots: ['eth0', 'eth1', 'eth2'],
    fabricDeviceIds: ['tp0'],
  })
  const kept = truncateSampleToCapabilityPlan(sample, plan, mapping).networks.map((n) => n.deviceId)
  assertEquals(kept, ['eth0', 'eth1', 'tp0'])

  const selfHosted = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'self-hosted')
  assertEquals(
    truncateSampleToCapabilityPlan(sample, selfHosted, mapping).networks.map((n) => n.deviceId),
    ['eth0', 'eth1', 'eth2', 'tp0']
  )

  const noFabric = resolveMetricsCapabilityPlan(
    'virtual',
    undefined,
    { turboFabricEnabled: false },
    'self-hosted'
  )
  assertEquals(
    truncateSampleToCapabilityPlan(sample, noFabric, mapping).networks.map((n) => n.deviceId),
    ['eth0', 'eth1', 'eth2']
  )
})

test('truncateSampleToCapabilityPlan: a slot-mapped NIC absent from the sample is simply missing — no other device takes its slot', () => {
  const sample: MetricsSample = {
    ...emptySample(),
    networks: ['eth1', 'eth5'].map(makeNetwork),
  }
  const plan = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'hosted')
  const mapping = emptySlotMappingForNetworks({
    normalNicSlots: ['eth0', 'eth1'],
  })
  assertEquals(
    truncateSampleToCapabilityPlan(sample, plan, mapping).networks.map((n) => n.deviceId),
    ['eth1']
  )
})

test('truncateSampleToCapabilityPlan: without a slot mapping, networks fall back to the first normalNicSlots entries positionally', () => {
  const sample: MetricsSample = {
    ...emptySample(),
    networks: ['eth0', 'eth1', 'eth2', 'tp0'].map(makeNetwork),
  }
  const hosted = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'hosted')
  assertEquals(
    truncateSampleToCapabilityPlan(sample, hosted).networks.map((n) => n.deviceId),
    ['eth0', 'eth1']
  )
  const selfHosted = resolveMetricsCapabilityPlan('virtual', undefined, undefined, 'self-hosted')
  assertEquals(selfHosted.normalNicSlots, MAX_NIC_SLOTS)
  assertEquals(
    truncateSampleToCapabilityPlan(sample, selfHosted).networks.map((n) => n.deviceId),
    ['eth0', 'eth1', 'eth2', 'tp0']
  )
})

// ---------------------------------------------------------------------------
// Machine class
// ---------------------------------------------------------------------------

test('isServerMachineClass accepts only the two declared values', () => {
  assertEquals(isServerMachineClass('physical'), true)
  assertEquals(isServerMachineClass('virtual'), true)
  assertEquals(isServerMachineClass(null), false)
  assertEquals(isServerMachineClass(undefined), false)
  assertEquals(isServerMachineClass('PHYSICAL'), false)
  assertEquals(isServerMachineClass('bare-metal'), false)
})

test("inferServerMachineClass: the daemon's own verdict on the snapshot wins over the sensor proxy", () => {
  // Bare metal with nothing discoverable: v4 read this as virtual.
  assertEquals(
    inferServerMachineClass({ machineClass: 'physical', hardwareSignals: [] }),
    'physical'
  )
  // A passthrough-GPU VM that somehow carries a signal stays virtual.
  assertEquals(
    inferServerMachineClass({ machineClass: 'virtual', hardwareSignals: [{ signalId: 'cpu' }] }),
    'virtual'
  )
  // A malformed verdict is ignored and the proxy decides: the array is
  // present and empty, so absence of proof reads virtual even with a
  // sample count beside it.
  assertEquals(
    inferServerMachineClass({ machineClass: 'bare-metal', hardwareSignals: [] }, 2),
    'virtual'
  )
  assertEquals(inferServerMachineClass({ machineClass: 'bare-metal' }, 2), 'physical')
})

test('inferServerMachineClass: a non-empty hardwareSignals array is proof of physical', () => {
  assertEquals(inferServerMachineClass({ hardwareSignals: [{ signalId: 'cpu' }] }), 'physical')
  assertEquals(inferServerMachineClass({ hardwareSignals: [] }), 'virtual')
})

test('inferServerMachineClass falls through to the sample only when the snapshot lacks the array', () => {
  assertEquals(inferServerMachineClass(undefined, 2), 'physical')
  assertEquals(inferServerMachineClass(undefined, 0), 'virtual')
  assertEquals(inferServerMachineClass({}, 1), 'physical')
  assertEquals(inferServerMachineClass([], 1), 'physical')
  // A snapshot that carries the array is authoritative over the sample.
  assertEquals(inferServerMachineClass({ hardwareSignals: [] }, 5), 'virtual')
})

test('resolveServerMachineClass: the declared column beats every inference', () => {
  assertEquals(resolveServerMachineClass('virtual', { hardwareSignals: [{}] }, 3), 'virtual')
  assertEquals(resolveServerMachineClass('physical', { hardwareSignals: [] }, 0), 'physical')
})

test('resolveServerMachineClass: NULL and out-of-range declarations fall back to inference', () => {
  assertEquals(resolveServerMachineClass(null, { hardwareSignals: [{}] }), 'physical')
  assertEquals(resolveServerMachineClass(undefined, { hardwareSignals: [] }), 'virtual')
  assertEquals(resolveServerMachineClass('bare-metal', undefined, 1), 'physical')
  assertEquals(resolveServerMachineClass('', undefined, 0), 'virtual')
})

test('isUnmarkedLiveCadenceInterval flags 10 s live ticks and spares priming/baseline', () => {
  assertEquals(isUnmarkedLiveCadenceInterval(10), true)
  assertEquals(isUnmarkedLiveCadenceInterval(15), true)
  assertEquals(isUnmarkedLiveCadenceInterval(8), true)
  assertEquals(isUnmarkedLiveCadenceInterval(2), false)
  assertEquals(isUnmarkedLiveCadenceInterval(7), false)
  assertEquals(isUnmarkedLiveCadenceInterval(METRICS_BASELINE_INTERVAL_SECONDS), false)
  assertEquals(isUnmarkedLiveCadenceInterval(55), false)
  assertEquals(isUnmarkedLiveCadenceInterval(16), false)
  assertEquals(isUnmarkedLiveCadenceInterval(0), false)
  assertEquals(isUnmarkedLiveCadenceInterval(Number.NaN), false)
})
