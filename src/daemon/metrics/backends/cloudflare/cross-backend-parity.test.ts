/**
 * Cross-backend parity — DuckDB vs. Cloudflare Analytics Engine — for the v4
 * contract. Supersedes `write-path-parity.test.ts`'s role for v4 (that file
 * stays as the v3 record; it is deleted in the v3-removal phase, not here).
 *
 * This exercises the actual read path on both backends, not just the
 * write-path packer: identical logical samples are written through (a)
 * `DuckDbParquetServerMetricsStore.writeSample` and (b)
 * `CloudflareAnalyticsEngineServerMetricsStoreV4.writeSample` backed by
 * `createFakeAnalyticsEngineV4` (`testing/fake-analytics-engine-v4.ts`) — an
 * in-memory DuckDB table shaped like the real AE dataset that the real
 * `queryXViaSqlApiV4` SQL text executes against, so the AE side is a genuine
 * executed read path, not a canned/decoded stand-in. Both stores are then
 * queried back through the exact same `ServerMetricsStoreV4` methods and
 * compared: series values, sample counts, gap counts, `latestAt`, uptime,
 * and events.
 *
 * Includes a mid-stream topology-generation bump (a GPU added, so
 * `slotMapping.gpuPageOrder` grows and an existing GPU's page/slot
 * assignment is recomputed) to prove parity holds across a generation
 * change too, not just within one static topology.
 */
import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { buildMetricsSampleV4, type MetricsSampleV4Input } from '../../contract-v4.ts'
import {
  resolveMetricsCapabilityPlan,
  truncateSampleToCapabilityPlanV4,
} from '../../capability-plan.ts'
import type { AuthenticatedMetricsSampleV4, SlotMapping } from '../../types-v4.ts'
import type { ServerStatusEvent } from '../../types-v4.ts'
import { DuckDbParquetServerMetricsStore } from '../duckdb/store.ts'
import { CloudflareAnalyticsEngineServerMetricsStoreV4 } from './store-v4.ts'
import { createFakeAnalyticsEngineV4 } from '../../testing/fake-analytics-engine-v4.ts'

const SERVER_ID = '11111111-2222-4333-8444-555555555555'
const BASE_MS = Date.UTC(2026, 5, 2)
const INTERVAL_SECONDS = 60

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

function gpu(gpuId: string, seed: number) {
  return {
    gpuId,
    utilizationPercent: seed,
    memoryUsedBytes: seed * 1000,
    memoryActivityPercent: seed,
    temperatureCelsius: 40 + seed,
    memoryTemperatureCelsius: 41 + seed,
    powerWatts: 100 + seed,
    pcieReceiveBytesPerSecond: seed * 10,
    pcieTransmitBytesPerSecond: seed * 11,
    throttlePercent: 0,
  }
}

function inputForTick(opts: {
  sequence: number
  atMs: number
  topologyGeneration: number
  cpuBusy: number
  gpus: ReturnType<typeof gpu>[]
  events?: MetricsSampleV4Input['events']
}): MetricsSampleV4Input {
  return {
    metadata: {
      version: 4,
      sampledAt: new Date(opts.atMs).toISOString(),
      intervalSeconds: INTERVAL_SECONDS,
      sequence: opts.sequence,
      collectionMode: 'baseline',
      topologyGeneration: opts.topologyGeneration,
      bootGeneration: 1,
    },
    host: {
      cpu: {
        busyPercent: opts.cpuBusy,
        userPercent: null,
        systemPercent: null,
        iowaitPercent: null,
        stealPercent: null,
        softirqPercent: null,
        pressureSomePercent: null,
        maxCoreBusyPercent: null,
        procsRunning: null,
        procsBlocked: null,
        processCount: null,
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
    networks: [nic('eth0', 1), nic('eth1', 2)],
    filesystems: [],
    blockDevices: [],
    gpus: opts.gpus,
    hardwareSignals: [],
    ingressSources: [],
    databaseProxies: [],
    events: opts.events ?? [],
  }
}

it('cross-backend parity: DuckDB and Cloudflare AE agree on host series, entity series, summary, status, and events', async () => {
  const metricsDir = await Deno.makeTempDir({
    prefix: 'tp-cross-backend-parity-',
  })
  const duckStore = new DuckDbParquetServerMetricsStore({ metricsDir }, { writeBatchMaxRows: 1 })
  const fakeAe = await createFakeAnalyticsEngineV4()
  const aeStore = new CloudflareAnalyticsEngineServerMetricsStoreV4(fakeAe.dataset, {
    sql: fakeAe.sqlConfig,
  })
  const plan = resolveMetricsCapabilityPlan(
    'virtual',
    undefined,
    {
      gpuSlots: 2,
    },
    'hosted'
  )
  try {
    // Tick 1: generation 1, one GPU.
    const tick1Input = inputForTick({
      sequence: 1,
      atMs: BASE_MS,
      topologyGeneration: 1,
      cpuBusy: 12,
      gpus: [gpu('gpu0', 5)],
      events: [
        {
          eventId: '11111111-1111-4111-8111-111111111111',
          at: new Date(BASE_MS).toISOString(),
          kind: 'oom_kill',
          severity: 'critical',
          payload: { pid: 1234 },
        },
      ],
    })
    const tick1Built = truncateSampleToCapabilityPlanV4(buildMetricsSampleV4(tick1Input), plan)
    const tick1Sample: AuthenticatedMetricsSampleV4 = {
      ...tick1Built,
      serverId: SERVER_ID,
      receivedAt: tick1Input.metadata.sampledAt,
    }
    const tick1SlotMapping = emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0'],
    })
    await duckStore.writeSample(tick1Sample)
    fakeAe.setNow(BASE_MS)
    aeStore.writeSample(tick1Sample, tick1SlotMapping)

    // Tick 2: generation 2 (a GPU added — the bump), two GPUs. Deliberately
    // skips tick 1 + 1 interval so the queried range also has a real gap on
    // both backends (gapCount parity, not just point-value parity).
    const tick2AtMs = BASE_MS + INTERVAL_SECONDS * 1000 * 2
    const tick2Input = inputForTick({
      sequence: 2,
      atMs: tick2AtMs,
      topologyGeneration: 2,
      cpuBusy: 34,
      gpus: [gpu('gpu0', 7), gpu('gpu1', 9)],
    })
    const tick2Built = truncateSampleToCapabilityPlanV4(buildMetricsSampleV4(tick2Input), plan)
    const tick2Sample: AuthenticatedMetricsSampleV4 = {
      ...tick2Built,
      serverId: SERVER_ID,
      receivedAt: tick2Input.metadata.sampledAt,
    }
    const tick2SlotMapping = emptySlotMapping({
      normalNicSlots: ['eth0', 'eth1'],
      gpuPageOrder: ['gpu0', 'gpu1'],
    })
    await duckStore.writeSample(tick2Sample)
    fakeAe.setNow(tick2AtMs)
    aeStore.writeSample(tick2Sample, tick2SlotMapping)

    const statusEvent: ServerStatusEvent = {
      serverId: SERVER_ID,
      at: new Date(BASE_MS).toISOString(),
      connected: true,
      reason: 'connect',
    }
    await duckStore.writeStatusEvent(statusEvent)
    fakeAe.setNow(BASE_MS)
    aeStore.writeStatusEvent(statusEvent)

    const from = new Date(BASE_MS - 60_000).toISOString()
    const to = new Date(tick2AtMs + 60_000).toISOString()

    // --- host series: values, sample count, gap count all agree ---
    const hostQuery = {
      serverId: SERVER_ID,
      metrics: ['host.cpu.busyPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckHost = await duckStore.queryHostSeries(hostQuery)
    const aeHost = await aeStore.queryHostSeries(hostQuery)
    assertEquals(aeHost.gapCount, duckHost.gapCount, 'gapCount must agree')
    assertEquals(aeHost.sampleCount, duckHost.sampleCount, 'sampleCount must agree')
    const duckHostByAt = new Map(
      duckHost.points.map((p) => [p.at, p.values['host.cpu.busyPercent']])
    )
    const aeHostByAt = new Map(aeHost.points.map((p) => [p.at, p.values['host.cpu.busyPercent']]))
    assertEquals(
      aeHostByAt.get(tick1Sample.metadata.sampledAt),
      duckHostByAt.get(tick1Sample.metadata.sampledAt)
    )
    assertEquals(
      aeHostByAt.get(tick2Sample.metadata.sampledAt),
      duckHostByAt.get(tick2Sample.metadata.sampledAt)
    )
    assertEquals(aeHostByAt.get(tick1Sample.metadata.sampledAt), tick1Input.host.cpu.busyPercent)

    // --- entity series: gpu0 (both ticks) and gpu1 (only from the generation bump) ---
    const gpu0Query = {
      serverId: SERVER_ID,
      family: 'gpu' as const,
      entityIds: ['gpu0'],
      metrics: ['utilizationPercent'],
      from,
      to,
      resolutionSeconds: INTERVAL_SECONDS,
    }
    const duckGpu0 = await duckStore.queryEntitySeries(gpu0Query)
    const aeGpu0 = await aeStore.queryEntitySeries(gpu0Query)
    const duckGpu0Entity = duckGpu0.entities.find((e) => e.entityId === 'gpu0')!
    const aeGpu0Entity = aeGpu0.entities.find((e) => e.entityId === 'gpu0')!
    const duckGpu0ByAt = new Map(
      duckGpu0Entity.points.map((p) => [p.at, p.values.utilizationPercent])
    )
    const aeGpu0ByAt = new Map(aeGpu0Entity.points.map((p) => [p.at, p.values.utilizationPercent]))
    assertEquals(
      aeGpu0ByAt.get(tick1Sample.metadata.sampledAt),
      duckGpu0ByAt.get(tick1Sample.metadata.sampledAt)
    )
    assertEquals(
      aeGpu0ByAt.get(tick2Sample.metadata.sampledAt),
      duckGpu0ByAt.get(tick2Sample.metadata.sampledAt)
    )

    const gpu1Query = { ...gpu0Query, entityIds: ['gpu1'] }
    const duckGpu1 = await duckStore.queryEntitySeries(gpu1Query)
    const aeGpu1 = await aeStore.queryEntitySeries(gpu1Query)
    const duckGpu1Entity = duckGpu1.entities.find((e) => e.entityId === 'gpu1')!
    const aeGpu1Entity = aeGpu1.entities.find((e) => e.entityId === 'gpu1')!
    assertEquals(aeGpu1Entity.points.length, duckGpu1Entity.points.length)
    assertEquals(aeGpu1Entity.points.length, 1, 'gpu1 only exists from the generation-2 tick')
    assertEquals(
      aeGpu1Entity.points[0]!.values.utilizationPercent,
      duckGpu1Entity.points[0]!.values.utilizationPercent
    )

    // --- host summary: sample count + latestAt agree ---
    const summaryQuery = { serverId: SERVER_ID, from, to }
    const duckSummary = await duckStore.queryHostSummary(summaryQuery)
    const aeSummary = await aeStore.queryHostSummary(summaryQuery)
    assertEquals(aeSummary.sampleCount, duckSummary.sampleCount)
    assertEquals(aeSummary.latestAt, duckSummary.latestAt)

    // --- status history: uptime split agrees ---
    const statusQuery = { serverId: SERVER_ID, from, to }
    const duckStatus = await duckStore.queryStatusHistory(statusQuery)
    const aeStatus = await aeStore.queryStatusHistory(statusQuery)
    assertEquals(aeStatus.uptimeSeconds, duckStatus.uptimeSeconds)
    assertEquals(aeStatus.downtimeSeconds, duckStatus.downtimeSeconds)
    assertEquals(aeStatus.uptimePercent, duckStatus.uptimePercent)
    assertEquals(aeStatus.events.length, duckStatus.events.length)

    // --- metric events: the tick-1 oom_kill event round-trips identically ---
    const eventsQuery = { serverId: SERVER_ID, from, to }
    const duckEvents = await duckStore.queryMetricEvents(eventsQuery)
    const aeEvents = await aeStore.queryMetricEvents(eventsQuery)
    assertEquals(aeEvents.events.length, duckEvents.events.length)
    assertEquals(aeEvents.events.length, 1)
    assertEquals(aeEvents.events[0]!.kind, duckEvents.events[0]!.kind)
    assertEquals(aeEvents.events[0]!.severity, duckEvents.events[0]!.severity)
    assertEquals(aeEvents.events[0]!.at, duckEvents.events[0]!.at)
  } finally {
    await duckStore.close()
    await fakeAe.close()
    await Deno.remove(metricsDir, { recursive: true })
  }
})
