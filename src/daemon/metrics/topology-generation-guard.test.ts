/**
 * Topology-reinterpretation guard for the v5 metrics write path.
 *
 * `host.io`'s embedded NIC slots (double14..19 — see `field-map.ts`'s
 * module doc comment) carry no per-slot identity of their own: which
 * `networks[]` entry a slot represents is resolved only through the
 * `SlotMapping` passed to `buildMetricsDataPoints` at write time. Every
 * other paged family (gpu/network/filesystem/block/hardware.physical) stamps
 * blob10 with the contributing entities' real ids, so a stored row is
 * self-describing regardless of which topology generation produced it; NICs
 * embedded in `host.io` are the one place a topology reassignment could
 * silently reinterpret a slot if the wrong generation's mapping were ever
 * used to decode it. DuckDB has no equivalent risk — it writes every network
 * device to its per-family table keyed by real `deviceId` regardless of slot
 * embedding (`types.ts`'s `EntitySeriesQuery` doc comment) — so this
 * guard is scoped to the Cloudflare AE write path only.
 *
 * The write-path packing tests below prove the packer itself is
 * identity-addressed (not positional) once a `SlotMapping` is available, and
 * that every row carries its own sample's `topologyGeneration` so a
 * downstream reader can regroup rows by generation. Further down,
 * `createFakeAnalyticsEngine` (`testing/fake-analytics-engine.ts`) — an
 * in-memory DuckDB-backed AE dataset the real `queryXViaSqlApi` SQL text
 * executes against — extends this to the read path: historical query
 * results for both a generation-reordered paged family (GPU page-position
 * swap) and the host series must keep resolving each row by its own
 * generation/identity, never reinterpreted under a later generation's
 * mapping.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildMetricsSample,
  type HostCpuMetrics,
  type HostKernelMetrics,
  type HostMemoryMetrics,
  type HostNetworkMetrics,
  type HostStorageMetrics,
  type MetricsSampleInput,
} from './contract.ts'
import type { AuthenticatedMetricsSample, SlotMapping } from './types.ts'
import {
  AE_BLOB_FAMILY_INDEX,
  AE_BLOB_TOPOLOGY_GENERATION_INDEX,
  AE_FAMILY_HOST_IO,
  AE_FAMILY_HOST_SYSTEM,
  AE_FAMILY_NETWORK,
  AE_MISSING_METRIC_SENTINEL,
  type AnalyticsEngineDataPointLike,
  buildMetricsDataPoints,
} from './backends/cloudflare/field-map.ts'
import { computeTopologyGenerationBreaks } from './query/series-response.ts'
import { CloudflareAnalyticsEngineServerMetricsStore } from './backends/cloudflare/store.ts'
import { createFakeAnalyticsEngine } from './testing/fake-analytics-engine.ts'

const HOST_CPU_FIELDS = [
  'busyPercent',
  'userPercent',
  'systemPercent',
  'iowaitPercent',
  'stealPercent',
  'softirqPercent',
  'pressureSomePercent',
  'saturatedCoreCount',
  'procsRunning',
  'procsBlocked',
  'processCount',
] as const satisfies readonly (keyof HostCpuMetrics)[]
const HOST_KERNEL_FIELDS = [
  'fileHandlesUsedPercent',
  'conntrackUsedPercent',
] as const satisfies readonly (keyof HostKernelMetrics)[]
const HOST_MEMORY_FIELDS = [
  'usedBytes',
  'cachedFilesBytes',
  'swapUsedBytes',
  'pressureSomePercent',
  'pressureFullPercent',
  'swapInBytesPerSecond',
  'swapOutBytesPerSecond',
  'majorPageFaultsPerSecond',
] as const satisfies readonly (keyof HostMemoryMetrics)[]
const HOST_STORAGE_FIELDS = [
  'ioPressureSomePercent',
  'ioPressureFullPercent',
  'diskReadBytesPerSecond',
  'diskWriteBytesPerSecond',
  'diskLatencyMs',
  'rootFilesystemAvailableBytes',
  'rootFilesystemFreeInodes',
] as const satisfies readonly (keyof HostStorageMetrics)[]
const HOST_NETWORK_FIELDS = [
  'tcpRetransmitPercent',
  'softnetDropsPerSecond',
] as const satisfies readonly (keyof HostNetworkMetrics)[]

function zeroFields<T extends readonly string[]>(fields: T): { [K in T[number]]: number | null } {
  const out = {} as { [K in T[number]]: number | null }
  for (const field of fields) out[field as T[number]] = null
  return out
}

function baseInput(overrides: Partial<MetricsSampleInput> = {}): MetricsSampleInput {
  return {
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    host: {
      cpu: zeroFields(HOST_CPU_FIELDS),
      kernel: zeroFields(HOST_KERNEL_FIELDS),
      memory: zeroFields(HOST_MEMORY_FIELDS),
      storage: zeroFields(HOST_STORAGE_FIELDS),
      network: zeroFields(HOST_NETWORK_FIELDS),
    },
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

function buildSample(overrides: Partial<MetricsSampleInput> = {}): AuthenticatedMetricsSample {
  const built = buildMetricsSample(baseInput(overrides))
  return {
    ...built,
    serverId: '11111111-2222-4333-8444-555555555555',
    receivedAt: '2026-01-01T00:00:01.000Z',
  }
}

function nic(deviceId: string, seed: number) {
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

function hostIoPoint(points: AnalyticsEngineDataPointLike[]): AnalyticsEngineDataPointLike {
  const found = points.find(
    (point) => point.blobs[AE_BLOB_FAMILY_INDEX] === AE_FAMILY_HOST_IO
  )
  if (!found) throw new Error('no host.io point found')
  return found
}

// host.io's NIC0 rx-bytes/s embed slot: HOST_IO_FIELD_ORDER.length (13 in v6 —
// 2 host.kernel + 7 host.storage + 1 spare + 2 host.network + 1 spare) + 0.
const NIC0_RX_DOUBLE_INDEX = 13

// ---------------------------------------------------------------------------
// Own-generation resolution: two generations, two distinct devices, each
// decoded with its own recorded SlotMapping.
// ---------------------------------------------------------------------------

it("generation 1's host.io row embeds generation 1's own slot-mapped NIC", () => {
  const sampleGen1 = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-01T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 1,
      topologyGeneration: 1,
      bootGeneration: 1,
    },
    networks: [nic('eth0', 100)],
  })
  const slotMappingGen1 = emptySlotMapping({ normalNicSlots: ['eth0'] })
  const point = hostIoPoint(buildMetricsDataPoints(sampleGen1, slotMappingGen1))
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], 100)
})

it("generation 2's host.io row embeds generation 2's own (replaced) slot-mapped NIC", () => {
  const sampleGen2 = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-02T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 2,
      topologyGeneration: 2,
      bootGeneration: 1,
    },
    networks: [nic('eth1', 300)],
  })
  const slotMappingGen2 = emptySlotMapping({ normalNicSlots: ['eth1'] })
  const point = hostIoPoint(buildMetricsDataPoints(sampleGen2, slotMappingGen2))
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], 300)
})

it("decoding generation 2's sample with generation 1's mapping never finds the replaced device (proves resolution is identity-addressed, not positional)", () => {
  const sampleGen2 = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-02T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 2,
      topologyGeneration: 2,
      bootGeneration: 1,
    },
    networks: [nic('eth1', 300)],
  })
  const wrongGenerationMapping = emptySlotMapping({ normalNicSlots: ['eth0'] })
  const point = hostIoPoint(buildMetricsDataPoints(sampleGen2, wrongGenerationMapping))
  // eth0 does not exist in this sample under the wrong (stale) mapping —
  // the slot goes missing rather than silently reading eth1's value under
  // eth0's name.
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], AE_MISSING_METRIC_SENTINEL)
})

it('the same raw sample decodes to different slot-1 values under a swapped mapping (real identity resolution, not array-position packing)', () => {
  // Both devices are simultaneously present (e.g. a topology reorder that
  // renumbered which uplink is "primary" without physically removing
  // either NIC) — network array order stays [eth0, eth1] in both cases.
  const sample = buildSample({
    networks: [nic('eth0', 100), nic('eth1', 300)],
  })
  const mappingA = emptySlotMapping({
    normalNicSlots: ['eth0', 'eth1'],
  })
  const mappingB = emptySlotMapping({
    normalNicSlots: ['eth1', 'eth0'],
  })
  const pointA = hostIoPoint(buildMetricsDataPoints(sample, mappingA))
  const pointB = hostIoPoint(buildMetricsDataPoints(sample, mappingB))
  assertEquals(pointA.doubles[NIC0_RX_DOUBLE_INDEX], 100)
  assertEquals(pointB.doubles[NIC0_RX_DOUBLE_INDEX], 300)
})

// ---------------------------------------------------------------------------
// Positional fallback (no recorded SlotMapping yet) — documented
// graceful-degradation behavior.
// ---------------------------------------------------------------------------

it('without a SlotMapping, host.io falls back to positional embedding (networks[0]/networks[1])', () => {
  const sample = buildSample({
    networks: [nic('eth0', 100), nic('eth1', 300)],
  })
  const point = hostIoPoint(buildMetricsDataPoints(sample, undefined))
  assertEquals(point.doubles[NIC0_RX_DOUBLE_INDEX], 100)
})

// ---------------------------------------------------------------------------
// blob7 (topologyGeneration) carries each sample's own generation on every
// row kind, so a downstream reader can regroup rows by generation even
// without per-slot ids.
// ---------------------------------------------------------------------------

it("every row (host.system, host.io, and a paged family) carries its own sample's topologyGeneration in blob7", () => {
  const sample = buildSample({
    metadata: {
      version: 6,
      sampledAt: '2026-01-03T00:00:00.000Z',
      intervalSeconds: 60,
      sequence: 3,
      topologyGeneration: 7,
      bootGeneration: 1,
    },
    networks: [nic('eth0', 1), nic('eth1', 2), nic('eth2', 3), nic('eth3', 4)],
  })
  const points = buildMetricsDataPoints(sample, undefined)
  const families = points.map((point) => point.blobs[AE_BLOB_FAMILY_INDEX])
  assertEquals(
    families.includes(AE_FAMILY_HOST_SYSTEM) &&
      families.includes(AE_FAMILY_HOST_IO) &&
      families.includes(AE_FAMILY_NETWORK),
    true
  )
  for (const point of points) {
    assertEquals(
      point.blobs[AE_BLOB_TOPOLOGY_GENERATION_INDEX],
      '7',
      `family ${
        point.blobs[AE_BLOB_FAMILY_INDEX]
      } must carry its own sample's topologyGeneration`
    )
  }
})

// ---------------------------------------------------------------------------
// computeTopologyGenerationBreaks — v5 analogue of v3's
// computeGenerationBreaks, at the already-decoded query-result layer.
// ---------------------------------------------------------------------------

it('computeTopologyGenerationBreaks: empty input has no breaks', () => {
  assertEquals(computeTopologyGenerationBreaks([]), [])
})

it('computeTopologyGenerationBreaks: all points sharing one generation have no breaks', () => {
  const points = [
    { topologyGeneration: 1 },
    { topologyGeneration: 1 },
    {
      topologyGeneration: 1,
    },
  ]
  assertEquals(computeTopologyGenerationBreaks(points), [])
})

it('computeTopologyGenerationBreaks: a null/undefined entry is unknown and never itself a break', () => {
  const points = [
    { topologyGeneration: 1 },
    { topologyGeneration: null },
    { topologyGeneration: undefined },
    { topologyGeneration: 1 },
  ]
  assertEquals(computeTopologyGenerationBreaks(points), [])
})

it('computeTopologyGenerationBreaks: the first point establishing a known generation is never a break', () => {
  const points = [{ topologyGeneration: null }, { topologyGeneration: 5 }]
  assertEquals(computeTopologyGenerationBreaks(points), [])
})

it('computeTopologyGenerationBreaks: marks the index where generation actually changes', () => {
  const points = [
    { topologyGeneration: 1 },
    { topologyGeneration: 1 },
    { topologyGeneration: 2 },
    { topologyGeneration: 2 },
    { topologyGeneration: 3 },
  ]
  assertEquals(computeTopologyGenerationBreaks(points), [2, 4])
})

it('computeTopologyGenerationBreaks: an unknown gap between two same-generation points is not a break', () => {
  const points = [
    { topologyGeneration: 1 },
    { topologyGeneration: null },
    { topologyGeneration: 1 },
  ]
  assertEquals(computeTopologyGenerationBreaks(points), [])
})

// ---------------------------------------------------------------------------
// Executed query-layer resolution (Cloudflare AE, via
// `createFakeAnalyticsEngine`) — proves the real `queryXViaSqlApi` SQL
// resolves historical rows by their own generation/identity after a
// reorder/swap, not just that the write-path packer produced the right
// bytes.
// ---------------------------------------------------------------------------

function gpu(gpuId: string, seed: number) {
  return {
    gpuId,
    utilizationPercent: seed,
    memoryUsedBytes: seed * 1000,
    memoryActivityPercent: seed,
    pcieReceiveBytesPerSecond: seed * 10,
    pcieTransmitBytesPerSecond: seed * 11,
    throttlePercent: 0,
  }
}

it("queryEntitySeries resolves each generation's page-position swap by identity, not by slot: a GPU that moves slots after a topology reorder never inherits the other GPU's value at its old timestamp", async () => {
  const SERVER_ID = '11111111-2222-4333-8444-555555555555'
  const BASE_MS = Date.UTC(2026, 5, 2)
  const INTERVAL_SECONDS = 60
  const fakeAe = await createFakeAnalyticsEngine()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    // Generation 1: gpu0 occupies page slot 0, gpu1 occupies slot 1.
    const gen1AtMs = BASE_MS
    const gen1Sample = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(gen1AtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 1,
        topologyGeneration: 1,
        bootGeneration: 1,
      },
      gpus: [gpu('gpu0', 11), gpu('gpu1', 22)],
    })
    fakeAe.setNow(gen1AtMs)
    store.writeSample(gen1Sample, emptySlotMapping({ gpuPageOrder: ['gpu0', 'gpu1'] }))

    // Generation 2: a topology reorder swaps page slots — gpu1 now occupies
    // slot 0 (where gpu0 used to be) and gpu0 occupies slot 1. New values so
    // a wrong-generation/positional read is distinguishable from a correct
    // identity-addressed one.
    const gen2AtMs = BASE_MS + INTERVAL_SECONDS * 1000
    const gen2Sample = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(gen2AtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 2,
        topologyGeneration: 2,
        bootGeneration: 1,
      },
      gpus: [gpu('gpu0', 33), gpu('gpu1', 44)],
    })
    fakeAe.setNow(gen2AtMs)
    store.writeSample(gen2Sample, emptySlotMapping({ gpuPageOrder: ['gpu1', 'gpu0'] }))

    const from = new Date(gen1AtMs - 60_000).toISOString()
    const to = new Date(gen2AtMs + 60_000).toISOString()

    const gpu0Series = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'gpu',
      entityIds: ['gpu0'],
      metrics: ['utilizationPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const gpu0 = gpu0Series.entities.find((e) => e.entityId === 'gpu0')!
    const gpu0ByAt = new Map(gpu0.points.map((p) => [p.at, p.values.utilizationPercent]))
    assertEquals(gpu0ByAt.get(gen1Sample.metadata.sampledAt), 11, 'gen1: gpu0 at slot 0')
    assertEquals(
      gpu0ByAt.get(gen2Sample.metadata.sampledAt),
      33,
      "gen2: gpu0 at slot 1 (swapped) — never gpu1's 44"
    )

    const gpu1Series = await store.queryEntitySeries({
      serverId: SERVER_ID,
      family: 'gpu',
      entityIds: ['gpu1'],
      metrics: ['utilizationPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    })
    const gpu1 = gpu1Series.entities.find((e) => e.entityId === 'gpu1')!
    const gpu1ByAt = new Map(gpu1.points.map((p) => [p.at, p.values.utilizationPercent]))
    assertEquals(gpu1ByAt.get(gen1Sample.metadata.sampledAt), 22, 'gen1: gpu1 at slot 1')
    assertEquals(
      gpu1ByAt.get(gen2Sample.metadata.sampledAt),
      44,
      "gen2: gpu1 at slot 0 (swapped) — never gpu0's 33"
    )
  } finally {
    await fakeAe.close()
  }
})

it("queryHostSeries: topologyGenerations reports both generations across a reorder, and each bucket keeps its own generation's value", async () => {
  const SERVER_ID = '11111111-2222-4333-8444-555555555555'
  const BASE_MS = Date.UTC(2026, 5, 3)
  const INTERVAL_SECONDS = 60
  const fakeAe = await createFakeAnalyticsEngine()
  const store = new CloudflareAnalyticsEngineServerMetricsStore(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  try {
    const gen1AtMs = BASE_MS
    const gen1Sample = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(gen1AtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 1,
        topologyGeneration: 1,
        bootGeneration: 1,
      },
      networks: [nic('eth0', 100)],
    })
    fakeAe.setNow(gen1AtMs)
    store.writeSample(gen1Sample, emptySlotMapping({ normalNicSlots: ['eth0'] }))

    // Generation 2: the reorder replaces eth0 with eth1 in the primary slot.
    const gen2AtMs = BASE_MS + INTERVAL_SECONDS * 1000
    const gen2Sample = buildSample({
      metadata: {
        version: 6,
        sampledAt: new Date(gen2AtMs).toISOString(),
        intervalSeconds: INTERVAL_SECONDS,
        sequence: 2,
        topologyGeneration: 2,
        bootGeneration: 1,
      },
      networks: [nic('eth1', 300)],
    })
    fakeAe.setNow(gen2AtMs)
    store.writeSample(gen2Sample, emptySlotMapping({ normalNicSlots: ['eth1'] }))

    const hostSeries = await store.queryHostSeries({
      serverId: SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from: new Date(gen1AtMs - 60_000).toISOString(),
      to: new Date(gen2AtMs + 60_000).toISOString(),
      resolutionSeconds: INTERVAL_SECONDS,
    })
    assertEquals(hostSeries.topologyGenerations, [1, 2])
    assertEquals(
      hostSeries.points.find((p) => p.at === gen1Sample.metadata.sampledAt)?.topologyGeneration,
      1
    )
    assertEquals(
      hostSeries.points.find((p) => p.at === gen2Sample.metadata.sampledAt)?.topologyGeneration,
      2
    )
  } finally {
    await fakeAe.close()
  }
})
